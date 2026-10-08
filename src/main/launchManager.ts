import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { LaunchStateEvent, UnifiedGame } from '../shared/types'
import type { HeroicDetection, SteamDetection } from './clients/detect'
import { launchThroughHeroic, quitHeroic, setHeroicSessionEnv } from './clients/heroic'
import {
  armSteamWindowSuppression,
  closeSteamWindow,
  closeVulkanShaderWindow,
  disarmSteamWindowSuppression,
  isSteamGameRunning,
  launchSteamGame,
  shutdownSteam,
  startSteamSilently
} from './clients/steam'
import {
  ensureSteamAutoAccept,
  ensureSteamShortcut,
  getSteamLaunchOptions,
  setSteamLaunchOptions,
  setSteamShortcutLaunchOptions,
  steamCefAvailable,
  waitForSteamCef,
  type SteamShortcut
} from './clients/steamCef'
import { loadSettings } from './config'
import { gamescopeArgs, inGamescopeSession, withGamescope } from './gamescope'
import { appConfigDir } from './paths'
import { addPlaySession } from './playtime'
import { detectControllerMode } from './controllerSupport'
import { getControllerMode, omniInputGameEnv, startOmniInput } from './omniInput'

export interface RuntimeContext {
  steam: SteamDetection
  heroic: HeroicDetection
}

type StateCb = (evt: LaunchStateEvent) => void

const runningIds = new Set<string>()

export function isRunning(gameId: string): boolean {
  return runningIds.has(gameId)
}

export async function launchGame(
  game: UnifiedGame,
  ctx: RuntimeContext,
  onState: StateCb
): Promise<void> {
  if (runningIds.has(game.id)) return
  // Reported immediately, not once a process actually exists - a Windows title with no
  // Proton available yet spends anywhere up to a couple of minutes downloading one (see
  // resolveOrInstallWineForGame) before anything spawns, and the Play button otherwise
  // sat fully clickable (and re-clickable) that whole time with zero indication anything
  // was happening. This is exactly the same "reported before dispatch" reasoning already
  // used for arming Steam's window suppression right below.
  runningIds.add(game.id)
  onState({ gameId: game.id, running: true })

  // Like the Steam Deck: games get gamescope from the session in Game Mode, and run without
  // it on the desktop - a nested gamescope hides the game's window from Steam, so Steam
  // Input can't route the controller to it. Opt-in for desktop via Settings. Detected per
  // launch, so a different monitor / refresh rate is picked up.
  const gamescope =
    loadSettings().useGamescope && !inGamescopeSession() ? await gamescopeArgs() : null

  if (game.store === 'steam') {
    await applyGamescopeToSteamGame(game.appId, gamescope)
    await runThroughSteam(game, ctx, onState, game.appId, game.appId)
    return
  }

  await runThroughHeroic(game, ctx, onState)
}

/**
 * Test build: a GOG/Epic/Amazon game is launched by Heroic itself, headless (heroic://
 * launch with --no-gui), and never touches Steam. OmniLauncher's own controller layer
 * (omniInput.ts) stands in for Steam Input for the session; Steam, if a Steam game left it
 * running, is closed first so it can't grab the same controllers.
 *
 * Heroic reads a game's config (where the session's environment goes) when it first loads
 * it and then keeps it in memory, so Heroic is quit before the launch and again after.
 * The game is followed by the OMNILAUNCHER_GAME_ID tag in its environment.
 */
async function runThroughHeroic(
  game: UnifiedGame,
  ctx: RuntimeContext,
  onState: StateCb
): Promise<void> {
  if (!ctx.heroic.present) {
    runningIds.delete(game.id)
    onState({ gameId: game.id, running: false, error: 'Heroic Games Launcher not found.' })
    return
  }

  await shutdownSteam(ctx.steam)
  await quitHeroic()
  const setting = getControllerMode(game.id)
  const mode = setting === 'auto' ? (await detectControllerMode(game)).mode : setting
  const input = await startOmniInput(mode, ctx.steam.root)
  setHeroicSessionEnv(ctx.heroic, game.appId, {
    OMNILAUNCHER_GAME_ID: game.id,
    ...(input ? omniInputGameEnv(input) : {})
  })

  let seenAt = 0
  let goneTicks = 0
  // Set once the game has been handed to Heroic; finish() may run before that.
  const timer: { poll?: NodeJS.Timeout } = {}
  if (!(await launchThroughHeroic(ctx.heroic, game))) {
    await finish("Heroic didn't launch the game - try launching it from Heroic to see why.")
    return
  }

  const startedAt = Date.now()
  // Heroic may first have to fetch a Proton/runtime update before the game starts.
  const START_TIMEOUT_MS = 180000
  timer.poll = setInterval(() => {
    if (isTaggedGameRunning(game.id)) {
      if (!seenAt) seenAt = Date.now()
      goneTicks = 0
      return
    }
    if (!seenAt) {
      if (Date.now() - startedAt > START_TIMEOUT_MS) {
        void finish("Heroic didn't start the game - try launching it from Heroic to see why.")
      }
      return
    }
    // Two misses in a row: a Proton game hands off between processes at startup.
    if (++goneTicks >= 2) void finish()
  }, 3000)

  async function finish(error?: string): Promise<void> {
    clearInterval(timer.poll)
    input?.stop()
    try {
      setHeroicSessionEnv(ctx.heroic, game.appId, null)
    } catch {
      // config unreadable - cleared again at next start
    }
    await quitHeroic()
    if (seenAt) addPlaySession(game.id, Math.round((Date.now() - seenAt) / 60000))
    runningIds.delete(game.id)
    onState({ gameId: game.id, running: false, ...(error ? { error } : {}) })
  }
}

/** Whether any process carries this game's OMNILAUNCHER_GAME_ID tag (set through Heroic's
 *  per-game environment, and inherited by everything the game starts). */
function isTaggedGameRunning(gameId: string): boolean {
  const needle = Buffer.from(`OMNILAUNCHER_GAME_ID=${gameId}\0`)
  let pids: string[]
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n))
  } catch {
    return false
  }
  for (const pid of pids) {
    try {
      if (readFileSync(`/proc/${pid}/environ`).includes(needle)) return true
    } catch {
      // gone, or not ours
    }
  }
  return false
}

/** Launches through the Steam client (a Steam game, or a GOG game's non-Steam shortcut)
 *  and reports running/stopped by watching Steam's own reaper process for it.
 *  `launchId` is what steam://rungameid/ takes; `reaperAppId` what the reaper is tagged
 *  with (AppId=...) - the same for Steam games, different for shortcuts. */
async function runThroughSteam(
  game: UnifiedGame,
  ctx: RuntimeContext,
  onState: StateCb,
  launchId: string,
  reaperAppId: string
): Promise<void> {
  // Armed BEFORE dispatch, not after - the "Launching..." dialog can appear within
  // milliseconds of the URI being handed to Steam, so suppression needs to already be
  // watching, not scrambling to start up in reaction to it.
  armSteamWindowSuppression()
  // Test build: Steam isn't started with OmniLauncher - only now, for a Steam game.
  if (startSteamSilently(ctx.steam)) await waitForSteamCef(120000)
  // Steam is headless, so a pre-launch question (EULA, notice, launch option...) would
  // otherwise wait forever on a dialog nobody can see - have Steam answer it itself.
  await ensureSteamAutoAccept()
  launchSteamGame(ctx.steam, launchId)
  // Steam manages its own process lifecycle & playtime bookkeeping, and detaches the
  // actual game from us entirely - so instead of guessing with a fixed timeout, poll
  // for the "reaper SteamLaunch AppId=..." process Steam itself launches every game
  // (native or Proton) under, and only report `running: false` once it's gone.
  const startedAt = Date.now()
  let runningSince = 0
  // Steam's "Launching..." and shader-cache dialogs only appear around launch, so they're
  // only hunted for until the game has been up a little while - polling wmctrl/xdotool
  // every 500 ms for the whole session made the compositor do work every tick, which
  // showed up as periodic stutter in games. After that, a cheap liveness check every 3 s.
  const LAUNCH_PHASE_MS = 20000
  const tick = (): boolean => {
    const inLaunchPhase = !runningSince || Date.now() - runningSince < LAUNCH_PHASE_MS
    if (inLaunchPhase) {
      // -silent keeps Steam's library window shut, but not the transient "Launching..."
      // dialog, nor the "Vulkan Shader Cache" one a Proton title can sit on before its
      // own window appears - both are minimized as soon as they show up.
      closeSteamWindow()
      closeVulkanShaderWindow()
    }
    const running = isSteamGameRunning(reaperAppId)
    if (running && !runningSince) runningSince = Date.now()
    return running
  }
  tick()
  let launchPhaseDone = false
  const poll = setInterval(() => {
    const running = tick()
    if (running && !launchPhaseDone && Date.now() - runningSince >= LAUNCH_PHASE_MS) {
      launchPhaseDone = true
      disarmSteamWindowSuppression()
      // Re-schedule at the slower in-game rate.
      clearInterval(poll)
      const slow = setInterval(() => {
        if (tick()) return
        clearInterval(slow)
        finish()
      }, 3000)
      return
    }
    if (running) return
    // Steam can take a few seconds to spawn the reaper after the URI is dispatched - a
    // not-found reading in that window isn't proof the game exited.
    if (Date.now() - startedAt < 8000) return
    clearInterval(poll)
    finish()
  }, 500)

  function finish(): void {
    disarmSteamWindowSuppression()
    runningIds.delete(game.id)
    onState({ gameId: game.id, running: false })
  }
}

/** Double-quotes a value for a Steam launch-options line (shell-style). */
function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`
}

/** Creates/updates the Steam shortcut for a GOG game: Steam runs python3 with umu, and the
 *  game's Proton / prefix / ids go in the shortcut's launch options (VAR=value %command%
 *  args). The shortcut's id is remembered so the game keeps a single Steam entry. */
export async function gogSteamShortcut(
  game: UnifiedGame,
  builder: { bin: string; args: string[]; env: NodeJS.ProcessEnv },
  ctx: RuntimeContext,
  gamescope: string[] | null = null
): Promise<SteamShortcut | null> {
  if (!ctx.steam.execCommand) return null
  if (startSteamSilently(ctx.steam)) await waitForSteamCef(120000)
  if (!(await steamCefAvailable())) return null

  const env: Record<string, string> = { OMNILAUNCHER_GAME_ID: game.id }
  for (const key of ['WINEPREFIX', 'PROTONPATH', 'GAMEID', 'STORE']) {
    const value = builder.env[key]
    if (value) env[key] = value
  }
  const launchOptions = withGamescope(
    [
      ...Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`),
      '%command%',
      ...builder.args.map(shellQuote)
    ].join(' '),
    gamescope
  )

  const map = readShortcutMap()
  const exe = builder.args[builder.args.length - 1]
  const shortcut = await ensureSteamShortcut({
    existingAppId: map[game.id],
    name: game.title,
    exe: '/usr/bin/python3',
    startDir: dirname(exe),
    launchOptions
  })
  if (shortcut) writeShortcutMap({ ...map, [game.id]: shortcut.appId })
  return shortcut
}

function shortcutMapPath(): string {
  return join(appConfigDir(), 'steam-shortcuts.json')
}

function readShortcutMap(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(shortcutMapPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function writeShortcutMap(map: Record<string, number>): void {
  writeFileSync(shortcutMapPath(), JSON.stringify(map, null, 2))
}

/** Keeps gamescope in (or out of) a Steam game's launch options before it's launched,
 *  leaving anything else the user set there untouched. Skipped when Steam's API can't be
 *  reached or doesn't return the current options - never overwrite what can't be read. */
async function applyGamescopeToSteamGame(appId: string, gamescope: string[] | null): Promise<void> {
  const current = await getSteamLaunchOptions(appId)
  if (current === null) return
  const next = withGamescope(current, gamescope)
  if (next !== current) await setSteamLaunchOptions(appId, next)
}

/** Brings already-configured games in line with the gamescope setting - launch options
 *  live in Steam, so a game launched from Steam directly would otherwise keep a gamescope
 *  prefix added earlier. Steam games and OmniLauncher's GOG shortcuts alike. */
export async function syncGamescopeLaunchOptions(steamAppIds: string[]): Promise<void> {
  const gamescope =
    loadSettings().useGamescope && !inGamescopeSession() ? await gamescopeArgs() : null
  for (const appId of steamAppIds) {
    const current = await getSteamLaunchOptions(appId)
    if (current === null || !current.includes('gamescope')) continue
    const next = withGamescope(current, gamescope)
    if (next !== current) await setSteamLaunchOptions(appId, next)
  }
  for (const shortcutId of Object.values(readShortcutMap())) {
    const current = await getSteamLaunchOptions(String(shortcutId))
    if (current === null || !current.includes('gamescope')) continue
    const next = withGamescope(current, gamescope)
    if (next !== current) await setSteamShortcutLaunchOptions(shortcutId, next)
  }
}
