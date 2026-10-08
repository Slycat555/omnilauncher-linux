import { ChildProcess, spawn } from 'child_process'
import type { InstallProgressEvent, UnifiedGame } from '../shared/types'
import type { HeroicDetection } from './clients/detect'
import type { SteamDetection } from './clients/detect'
import { existsSync, readdirSync } from 'fs'
import {
  buildAmazonInstallCommand,
  buildAmazonUninstallCommand,
  buildEpicInstallCommand,
  buildEpicUninstallCommand,
  buildGogInstallCommand,
  clearStaleGogManifest,
  markGogInstalled,
  resolveGogInstallDir,
  unmarkGogInstalled
} from './clients/heroic'
import { installSteamGame, readSteamInstallState, uninstallSteamGame } from './clients/steam'
import { steamCancelInstall } from './clients/steamCef'
import { hostEnv } from './hostEnv'

export interface RuntimeContext {
  steam: SteamDetection
  heroic: HeroicDetection
}

type ProgressCb = (evt: InstallProgressEvent) => void

/**
 * Progress lines differ between the backends, and notably gogdl prints no '%' sign at all:
 *   gogdl:     = Progress: 45.10 123456/999999, Running for: 00:00:12, ETA: 00:01:30
 *   legendary: = Progress: 45.10% (123456/999999), Running for 00:00:12, ETA: 00:01:30
 * A single case-sensitive '%'-based match therefore never fired for GOG and the bar
 * never moved.
 */
const PROGRESS_RE = /progress:\s*([\d.]+)\s*%?\s*\(?\s*(\d+)\s*\/\s*(\d+)\s*\)?/i
const ETA_RE = /ETA:\s*(\d{1,3}:\d{2}:\d{2})/
const SPEED_RE = /Download[\s\t]*[-:]\s*([\d.]+\s*[KMGT]i?B\/s)/i
const BARE_PERCENT_RE = /(\d{1,3}(?:\.\d+)?)\s*%/
/** legendary/gogdl/nile all print e.g. " - Downloaded: 22.82 MiB, Written: 28.19 MiB". */
const DOWNLOADED_RE = /Downloaded:\s*([\d.]+)\s*([KMGT]?i?B)\b/i

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4
}

function toBytes(value: string, unit: string): number | undefined {
  const factor = UNIT_BYTES[unit.toUpperCase()]
  const n = parseFloat(value)
  return factor && Number.isFinite(n) ? n * factor : undefined
}

/** True when the directory exists and holds something other than gogdl's own leftovers. */
function hasGameFiles(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some((name) => !name.startsWith('.'))
  } catch {
    return false
  }
}

interface ParsedProgress {
  percent?: number
  bytesDone?: number
  bytesTotal?: number
  eta?: string
  speed?: string
  downloadedBytes?: number
  speedBps?: number
}

function clampPercent(v: number): number | undefined {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : undefined
}

function parseProgressLine(line: string): ParsedProgress {
  const out: ParsedProgress = {}

  const progress = line.match(PROGRESS_RE)
  if (progress) {
    out.percent = clampPercent(parseFloat(progress[1]))
    const done = Number(progress[2])
    const total = Number(progress[3])
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
      out.bytesDone = done
      out.bytesTotal = total
      // Prefer the byte ratio: it is exact, where the printed percentage is rounded.
      out.percent = clampPercent((done / total) * 100)
    }
  } else {
    const bare = line.match(BARE_PERCENT_RE)
    if (bare) out.percent = clampPercent(parseFloat(bare[1]))
  }

  const eta = line.match(ETA_RE)
  if (eta) out.eta = eta[1]

  const speed = line.match(SPEED_RE)
  if (speed) {
    out.speed = speed[1].replace(/\s+/g, ' ')
    const [, value, unit] = out.speed.match(/([\d.]+)\s*([KMGT]i?B)\/s/i) ?? []
    if (value) out.speedBps = toBytes(value, unit)
  }

  // The "(done/total)" pair in the Progress line is a chunk count for legendary, not
  // bytes - this separate line is the only real byte figure the backends print.
  const downloaded = line.match(DOWNLOADED_RE)
  if (downloaded) out.downloadedBytes = toBytes(downloaded[1], downloaded[2])

  return out
}

interface SteamInstallTask {
  appId: string
  steam: SteamDetection
  cancelled: boolean
}

class InstallManager {
  private children = new Map<string, ChildProcess>()
  /** Steam installs have no child process of ours to kill - Steam owns the download -
   *  so cancelling has to go through Steam itself (see cancelSteam). */
  private steamTasks = new Map<string, SteamInstallTask>()

  isBusy(gameId: string): boolean {
    return this.children.has(gameId) || this.steamTasks.has(gameId)
  }

  async cancel(gameId: string, steam?: SteamDetection): Promise<void> {
    const task = this.steamTasks.get(gameId)
    if (task) {
      await this.cancelSteam(task)
      return
    }
    // A Steam download started outside OmniLauncher (shown via the library watcher) -
    // cancel it in Steam the same way as one of ours.
    if (steam && gameId.startsWith('steam:')) {
      await this.cancelSteam({ appId: gameId.slice('steam:'.length), steam, cancelled: true })
      return
    }
    const child = this.children.get(gameId)
    if (child && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      this.children.delete(gameId)
    }
  }

  private async cancelSteam(task: SteamInstallTask): Promise<void> {
    task.cancelled = true
    const state = task.steam.root ? readSteamInstallState(task.steam.root, task.appId) : null
    // No manifest yet: the install never started, only Steam's dialog is up.
    // Manifest without the FullyInstalled bit: a fresh install part-way through - its
    // partial files go too. FullyInstalled set: an update to a game that's already
    // installed - only stop the download, never uninstall the game itself.
    const wizardOnly = !state
    const freshInstall = !!state && (state.stateFlags & 4) === 0
    const handled = await steamCancelInstall(task.appId, {
      wizardOnly,
      removePartialFiles: freshInstall
    })
    // Without Steam's remote debugging there's no way to stop the download directly;
    // for a fresh install, Steam's own uninstall prompt is the next best thing.
    if (!handled && freshInstall) {
      void uninstallSteamGame(task.steam, task.appId).catch(() => {})
    }
  }

  private runCommand(
    gameId: string,
    cmd: { bin: string; args: string[]; env: NodeJS.ProcessEnv },
    onProgress: ProgressCb,
    successMessage: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      onProgress({ gameId, phase: 'starting', message: `${cmd.bin} ${cmd.args.join(' ')}` })
      const child = spawn(cmd.bin, cmd.args, {
        env: hostEnv(cmd.env),
        detached: true
      })
      this.children.set(gameId, child)

      const lastErrLines: string[] = []
      // The backends spread progress across several lines (percentage on one, speed on
      // another), so carry the last known values forward instead of blanking the UI.
      const latest: ParsedProgress = {}
      const handleLine = (raw: string, isErr: boolean): void => {
        if (isErr) {
          lastErrLines.push(raw)
          if (lastErrLines.length > 20) lastErrLines.shift()
        }
        Object.assign(latest, parseProgressLine(raw))
        onProgress({
          gameId,
          phase: 'downloading',
          percent: latest.percent,
          bytesDone: latest.bytesDone,
          bytesTotal: latest.bytesTotal,
          eta: latest.eta,
          speed: latest.speed,
          speedBps: latest.speedBps,
          downloadedBytes: latest.downloadedBytes,
          raw
        })
      }

      function pump(stream: NodeJS.ReadableStream, isErr: boolean): void {
        let pending = ''
        stream.on('data', (chunk: Buffer) => {
          pending += chunk.toString()
          const parts = pending.split('\n')
          pending = parts.pop() ?? ''
          for (const part of parts) handleLine(part, isErr)
        })
      }
      pump(child.stdout!, false)
      pump(child.stderr!, true)

      child.on('error', (err) => {
        this.children.delete(gameId)
        onProgress({ gameId, phase: 'error', message: err.message })
        reject(err)
      })

      child.on('close', (code) => {
        this.children.delete(gameId)
        if (code === 0) {
          onProgress({ gameId, phase: 'done', percent: 100, message: successMessage })
          resolve()
        } else {
          const message = lastErrLines.slice(-5).join('\n') || `Exited with code ${code}`
          onProgress({ gameId, phase: 'error', message })
          reject(new Error(message))
        }
      })
    })
  }

  /** Installs run strictly one after another - a second request waits for the first to
   *  finish, whatever path it arrived by. */
  private installChain: Promise<void> = Promise.resolve()

  install(game: UnifiedGame, ctx: RuntimeContext, onProgress: ProgressCb): Promise<void> {
    const run = this.installChain.then(() => this.runInstall(game, ctx, onProgress))
    this.installChain = run.catch(() => {})
    return run
  }

  private async runInstall(
    game: UnifiedGame,
    ctx: RuntimeContext,
    onProgress: ProgressCb
  ): Promise<void> {
    if (game.store === 'steam') {
      // Steam owns the actual download, but we poll the same manifest file it writes
      // progress to, so the UI still gets a real percentage and a real "done" once the
      // install genuinely finishes - not just once the URI was dispatched.
      onProgress({
        gameId: game.id,
        phase: 'starting',
        message: `${game.title}: waiting for Steam`
      })
      const task: SteamInstallTask = { appId: game.appId, steam: ctx.steam, cancelled: false }
      this.steamTasks.set(game.id, task)
      let outcome: Awaited<ReturnType<typeof installSteamGame>>
      try {
        outcome = await installSteamGame(
          ctx.steam,
          game.appId,
          (p) => {
            onProgress({
              gameId: game.id,
              phase: 'downloading',
              percent: p.percent,
              bytesDone: p.bytesDone,
              bytesTotal: p.bytesTotal,
              // Steam's manifest counts real bytes; speed is derived from these in the UI.
              downloadedBytes: p.bytesDone,
              totalBytes: p.bytesTotal
            })
          },
          () => task.cancelled
        )
      } finally {
        this.steamTasks.delete(game.id)
      }
      // Cancelled here or in Steam itself (its dialog, or removing the download) - either
      // way the game must not sit as "Installing…" forever.
      if (outcome === 'cancelled') {
        onProgress({
          gameId: game.id,
          phase: 'cancelled',
          message: task.cancelled
            ? `${game.title}: install cancelled`
            : `${game.title}: install cancelled in Steam`
        })
        return
      }
      onProgress({
        gameId: game.id,
        phase: 'done',
        percent: 100,
        message: `${game.title} installed`
      })
      return
    }

    if (game.store === 'gog') {
      const builder = buildGogInstallCommand(ctx.heroic, game)
      if (!builder) {
        onProgress({
          gameId: game.id,
          phase: 'error',
          message: 'Backend CLI not found for this store.'
        })
        throw new Error('Backend CLI not found')
      }
      // gogdl names the game's folder after GOG's installDirectory, which often differs
      // from the store title ("Amnesia - A Machine For Pigs" vs "Amnesia A Machine For
      // Pigs") - so the folder is found by the game's goggame-<id>.info, never assumed.
      if (!hasGameFiles(resolveGogInstallDir(builder.installPath, game.appId))) {
        clearStaleGogManifest(ctx.heroic, game.appId)
      }

      await this.runCommand(game.id, builder, onProgress, `${game.title} installed`)

      // gogdl exits 0 even when it decided there was nothing to download, so a zero exit
      // code alone is not proof of an install - check that files actually landed.
      const installDir = resolveGogInstallDir(builder.installPath, game.appId)
      if (!hasGameFiles(installDir)) {
        const message = 'Download produced no files. Try installing again.'
        onProgress({ gameId: game.id, phase: 'error', message })
        throw new Error(message)
      }
      // We call gogdl directly (bypassing Heroic's UI), so Heroic never learns the game
      // was installed unless we tell it ourselves via its own bookkeeping file.
      markGogInstalled(ctx.heroic, game.appId, installDir, 'windows')
      return
    }

    const builder =
      game.store === 'epic'
        ? buildEpicInstallCommand(ctx.heroic, game)
        : buildAmazonInstallCommand(ctx.heroic, game)

    if (!builder) {
      onProgress({
        gameId: game.id,
        phase: 'error',
        message: 'Backend CLI not found for this store.'
      })
      throw new Error('Backend CLI not found')
    }
    await this.runCommand(game.id, builder, onProgress, `${game.title} installed`)
  }

  async uninstall(game: UnifiedGame, ctx: RuntimeContext, onProgress: ProgressCb): Promise<void> {
    if (game.store === 'steam') {
      onProgress({ gameId: game.id, phase: 'starting', message: `${game.title}: uninstalling` })
      await uninstallSteamGame(ctx.steam, game.appId)
      onProgress({ gameId: game.id, phase: 'done', message: `${game.title} uninstalled` })
      return
    }
    const builder =
      game.store === 'epic'
        ? buildEpicUninstallCommand(ctx.heroic, game)
        : game.store === 'amazon'
          ? buildAmazonUninstallCommand(ctx.heroic, game)
          : null

    if (game.store === 'gog') {
      // gogdl has no uninstall verb; Heroic itself just removes the install dir.
      if (!game.installPath) throw new Error('Unknown install path')
      const { rm } = await import('fs/promises')
      onProgress({ gameId: game.id, phase: 'starting', message: `Removing ${game.installPath}` })
      await rm(game.installPath, { recursive: true, force: true })
      unmarkGogInstalled(ctx.heroic, game.appId)
      onProgress({ gameId: game.id, phase: 'done', message: 'Uninstalled' })
      return
    }

    if (!builder) {
      onProgress({
        gameId: game.id,
        phase: 'error',
        message: 'Backend CLI not found for this store.'
      })
      throw new Error('Backend CLI not found')
    }
    await this.runCommand(game.id, builder, onProgress, `${game.title} uninstalled`)
  }
}

export const installManager = new InstallManager()
