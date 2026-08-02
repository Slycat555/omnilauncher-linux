import { spawn } from 'child_process'
import type { LaunchStateEvent, UnifiedGame } from '../shared/types'
import type { HeroicDetection, SteamDetection } from './clients/detect'
import {
  buildAmazonLaunchCommand,
  buildEpicLaunchCommand,
  buildGogLaunchCommand,
  resolveWineForGame
} from './clients/heroic'
import { closeSteamWindow, closeVulkanShaderWindow, isSteamGameRunning, launchSteamGame } from './clients/steam'
import { addPlaySession } from './playtime'

export interface RuntimeContext {
  steam: SteamDetection
  heroic: HeroicDetection
}

type StateCb = (evt: LaunchStateEvent) => void

const runningIds = new Set<string>()

export function isRunning(gameId: string): boolean {
  return runningIds.has(gameId)
}

export function launchGame(game: UnifiedGame, ctx: RuntimeContext, onState: StateCb): void {
  if (runningIds.has(game.id)) return

  if (game.store === 'steam') {
    launchSteamGame(ctx.steam, game.appId)
    // Steam manages its own process lifecycle & playtime bookkeeping, and detaches the
    // actual game from us entirely - so instead of guessing with a fixed timeout, poll
    // for the "reaper SteamLaunch AppId=..." process Steam itself launches every game
    // (native or Proton) under, and only report `running: false` once it's gone.
    runningIds.add(game.id)
    onState({ gameId: game.id, running: true })
    const startedAt = Date.now()
    const poll = setInterval(() => {
      // A Proton title's first run (or any run after a driver update) can sit on
      // Steam's own "Vulkan Shader Cache" dialog for anywhere from seconds to several
      // minutes before the game's own window ever appears - close it on sight, the same
      // way an install's confirmation dialog gets backgrounded once it's served its
      // purpose. Checked every tick since there's no single moment to catch it at.
      closeVulkanShaderWindow()

      const running = isSteamGameRunning(game.appId)
      if (running) {
        // -silent keeps the main library window from opening on its own when we
        // dispatch the launch, but it does nothing if Steam was already visible before
        // the user hit Play (left open by them, or by an install/shader dialog) - once
        // the game is confirmed actually running, background it the same way an
        // install's window gets closed once a download is confirmed underway.
        closeSteamWindow()
        return
      }
      // Steam can take a few seconds to actually spawn the reaper process after the URI
      // is dispatched - a not-found reading in that window is expected, not proof the
      // game exited, so keep polling instead of declaring "not running" too early.
      if (Date.now() - startedAt < 8000) return
      clearInterval(poll)
      runningIds.delete(game.id)
      onState({ gameId: game.id, running: false })
    }, 2000)
    return
  }

  const wine = game.platform === 'windows' ? resolveWineForGame(ctx.heroic, game.appId) : null
  const builder =
    game.store === 'gog'
      ? buildGogLaunchCommand(ctx.heroic, game, wine, ctx.steam.root)
      : game.store === 'epic'
        ? buildEpicLaunchCommand(ctx.heroic, game, wine, ctx.steam.root)
        : buildAmazonLaunchCommand(ctx.heroic, game, wine)

  if (!builder) {
    onState({
      gameId: game.id,
      running: false,
      error:
        game.platform === 'windows'
          ? 'No Wine/Proton configured for this game. Configure it once in Heroic, then try again.'
          : 'Unable to build a launch command (backend CLI not found).'
    })
    return
  }

  const startedAt = Date.now()
  const child = spawn(builder.bin, builder.args, {
    env: { ...process.env, ...builder.env },
    detached: true
  })

  runningIds.add(game.id)
  onState({ gameId: game.id, running: true })

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
