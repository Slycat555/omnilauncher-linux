import { spawn } from 'child_process'
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
  launchSteamGame
} from './clients/steam'
import { addPlaySession } from './playtime'

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

  if (game.store === 'steam') {
    // Armed BEFORE dispatch, not after - the "Launching..." dialog can appear within
    // milliseconds of the URI being handed to Steam, so suppression needs to already be
    // watching, not scrambling to start up in reaction to it.
    armSteamWindowSuppression()
    launchSteamGame(ctx.steam, game.appId)
    // Steam manages its own process lifecycle & playtime bookkeeping, and detaches the
    // actual game from us entirely - so instead of guessing with a fixed timeout, poll
    // for the "reaper SteamLaunch AppId=..." process Steam itself launches every game
    // (native or Proton) under, and only report `running: false` once it's gone.
    const startedAt = Date.now()
    const tick = (): boolean => {
      // -silent keeps Steam's main library window from opening on its own, but it does
      // nothing about the transient "Launching..." dialog that appears immediately
      // after dispatch, well before the reaper process (isSteamGameRunning's signal)
      // exists - that dialog was previously only closed AFTER the game was confirmed
      // running, leaving a several-second gap where it sat on top of everything,
      // including our own NFC launch overlay. Closing it unconditionally on every tick,
      // same as the shader-cache dialog below, covers that whole window instead of just
      // the part after the game's actually up.
      closeSteamWindow()

      // A Proton title's first run (or any run after a driver update) can sit on
      // Steam's own "Vulkan Shader Cache" dialog for anywhere from seconds to several
      // minutes before the game's own window ever appears - close it on sight, the same
      // way an install's confirmation dialog gets backgrounded once it's served its
      // purpose. Checked every tick since there's no single moment to catch it at.
      closeVulkanShaderWindow()

      return isSteamGameRunning(game.appId)
    }
    // Run once immediately (not just on the first interval tick) so the "Launching..."
    // dialog gets a close attempt right away instead of waiting out a full interval -
    // it can render within a couple hundred ms of dispatch.
    tick()
    const poll = setInterval(() => {
      if (tick()) return
      // Steam can take a few seconds to actually spawn the reaper process after the URI
      // is dispatched - a not-found reading in that window is expected, not proof the
      // game exited, so keep polling instead of declaring "not running" too early.
      if (Date.now() - startedAt < 8000) return
      clearInterval(poll)
      disarmSteamWindowSuppression()
      runningIds.delete(game.id)
      onState({ gameId: game.id, running: false })
    }, 500)
    return
  }

  const wine =
    game.platform === 'windows'
      ? await resolveOrInstallWineForGame(ctx.heroic, game.store, game.appId, ctx.steam.root, game.id, onProgress)
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

  const startedAt = Date.now()
  const child = spawn(builder.bin, builder.args, {
    env: { ...process.env, ...builder.env },
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
    runningIds.delete(game.id)
    onState({ gameId: game.id, running: false, error: err.message })
  })

  child.on('close', (code) => {
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
