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
  unmarkGogInstalled
} from './clients/heroic'
import { installSteamGame, uninstallSteamGame } from './clients/steam'

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
  if (speed) out.speed = speed[1].replace(/\s+/g, ' ')

  return out
}

class InstallManager {
  private children = new Map<string, ChildProcess>()

  isBusy(gameId: string): boolean {
    return this.children.has(gameId)
  }

  cancel(gameId: string): void {
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

  private runCommand(
    gameId: string,
    cmd: { bin: string; args: string[]; env: NodeJS.ProcessEnv },
    onProgress: ProgressCb,
    successMessage: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      onProgress({ gameId, phase: 'starting', message: `${cmd.bin} ${cmd.args.join(' ')}` })
      const child = spawn(cmd.bin, cmd.args, {
        env: { ...process.env, ...cmd.env },
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

  async install(game: UnifiedGame, ctx: RuntimeContext, onProgress: ProgressCb): Promise<void> {
    if (game.store === 'steam') {
      // Steam owns the actual download, but we poll the same manifest file it writes
      // progress to, so the UI still gets a real percentage and a real "done" once the
      // install genuinely finishes - not just once the URI was dispatched.
      onProgress({ gameId: game.id, phase: 'starting', message: `${game.title}: waiting for Steam` })
      await installSteamGame(ctx.steam, game.appId, (p) => {
        onProgress({
          gameId: game.id,
          phase: 'downloading',
          percent: p.percent,
          bytesDone: p.bytesDone,
          bytesTotal: p.bytesTotal
        })
      })
      onProgress({ gameId: game.id, phase: 'done', percent: 100, message: `${game.title} installed` })
      return
    }

    if (game.store === 'gog') {
      const builder = buildGogInstallCommand(ctx.heroic, game)
      if (!builder) {
        onProgress({ gameId: game.id, phase: 'error', message: 'Backend CLI not found for this store.' })
        throw new Error('Backend CLI not found')
      }
      if (!hasGameFiles(builder.installPath)) clearStaleGogManifest(ctx.heroic, game.appId)

      await this.runCommand(game.id, builder, onProgress, `${game.title} installed`)

      // gogdl exits 0 even when it decided there was nothing to download, so a zero exit
      // code alone is not proof of an install - check that files actually landed.
      if (!hasGameFiles(builder.installPath)) {
        const message = 'Download produced no files. Try installing again.'
        onProgress({ gameId: game.id, phase: 'error', message })
        throw new Error(message)
      }
      // We call gogdl directly (bypassing Heroic's UI), so Heroic never learns the game
      // was installed unless we tell it ourselves via its own bookkeeping file.
      markGogInstalled(ctx.heroic, game.appId, builder.installPath, 'windows')
      return
    }

    const builder =
      game.store === 'epic'
        ? buildEpicInstallCommand(ctx.heroic, game)
        : buildAmazonInstallCommand(ctx.heroic, game)

    if (!builder) {
      onProgress({ gameId: game.id, phase: 'error', message: 'Backend CLI not found for this store.' })
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
      onProgress({ gameId: game.id, phase: 'error', message: 'Backend CLI not found for this store.' })
      throw new Error('Backend CLI not found')
    }
    await this.runCommand(game.id, builder, onProgress, `${game.title} uninstalled`)
  }

}

export const installManager = new InstallManager()
