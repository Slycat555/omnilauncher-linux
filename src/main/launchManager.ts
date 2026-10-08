import { spawn } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { InstallProgressEvent, LaunchStateEvent, UnifiedGame } from '../shared/types'
import type { HeroicDetection, SteamDetection } from './clients/detect'
import {
  buildAmazonLaunchCommand,
  buildEpicLaunchCommand,
  buildGogLaunchCommand,
  resolveOrInstallWineForGame
} from './clients/heroic'
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
import { hostEnv } from './hostEnv'
import { getControllerMode, omniInputGameEnv, startOmniInput } from './omniInput'

export interface RuntimeContext {
  steam: SteamDetection
  heroic: HeroicDetection
}

type StateCb = (evt: LaunchStateEvent) => void
type ProgressCb = (evt: InstallProgressEvent) => void

const runningIds = new Set<string>()

export function isRunning(gameId: string): boolean {
  return runningIds.has(gameId)
}

export async function launchGame(
  game: UnifiedGame,
  ctx: RuntimeContext,
  onState: StateCb,
  onProgress?: ProgressCb
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

  const wine =
    game.platform === 'windows'
      ? await resolveOrInstallWineForGame(
          ctx.heroic,
          game.store,
          game.appId,
          ctx.steam.root,
          game.id,
          onProgress,
          game.title
        )
      : null
  const builder =
    game.store === 'gog'
      ? buildGogLaunchCommand(ctx.heroic, game, wine, ctx.steam.root)
      : game.store === 'epic'
        ? buildEpicLaunchCommand(ctx.heroic, game, wine, ctx.steam.root)
        : buildAmazonLaunchCommand(ctx.heroic, game, wine)

  if (!builder) {
    runningIds.delete(game.id)
    onState({
      gameId: game.id,
      running: false,
      error:
        game.platform === 'windows'
          ? 'No Wine/Proton available and downloading Proton-GE failed - check your network connection and try again.'
          : 'Unable to build a launch command (backend CLI not found).'
    })
    return
  }

  // Test build: no Steam for non-Steam games. Steam is closed for the session (it would
  // grab the controllers too) and OmniLauncher's own controller layer stands in for Steam
  // Input; Steam comes back in the background, silently, once the game exits.
  const steamWasClosed = await shutdownSteam(ctx.steam)
  const input = await startOmniInput(getControllerMode(game.id), ctx.steam.root)
  let cleanedUp = false
  const afterGame = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    input?.stop()
    if (steamWasClosed) startSteamSilently(ctx.steam)
  }

  const startedAt = Date.now()
  // Direct launch: wrap the whole command in gamescope ourselves.
  const [bin, args] = gamescope
    ? ['gamescope', [...gamescope, builder.bin, ...builder.args]]
    : [builder.bin, builder.args]
  const child = spawn(bin, args, {
    // OMNILAUNCHER_GAME_ID is inherited down through Wine/Proton by the game itself - the
    // Wine monitor (wineMonitor.ts) uses it to recognise a real game launched from here.
    env: hostEnv({
      ...builder.env,
      ...(input ? omniInputGameEnv(input) : {}),
      OMNILAUNCHER_GAME_ID: game.id
    }),
    detached: true
  })

  let outputTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    outputTail = (outputTail + chunk.toString()).slice(-4000)
  })
  child.stdout?.on('data', (chunk: Buffer) => {
    outputTail = (outputTail + chunk.toString()).slice(-4000)
  })

  child.on('error', (err) => {
    afterGame()
    runningIds.delete(game.id)
    onState({ gameId: game.id, running: false, error: err.message })
  })

  child.on('close', (code) => {
    afterGame()
    runningIds.delete(game.id)
    const minutes = Math.round((Date.now() - startedAt) / 60000)
    addPlaySession(game.id, minutes)
    if (code !== 0 && code !== null) {
      const detail = outputTail.trim().split('\n').slice(-5).join(' | ')
      onState({
        gameId: game.id,
        running: false,
        error: detail || `Launcher exited with code ${code}`
      })
    } else {
      onState({ gameId: game.id, running: false })
    }
  })
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
