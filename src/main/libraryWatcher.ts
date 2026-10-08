import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { InstallProgressEvent } from '../shared/types'
import type { HeroicDetection, SteamDetection } from './clients/detect'
import {
  measureSteamDownloadBytes,
  readLibraryFolders,
  readSteamInstallState
} from './clients/steam'

const POLL_MS = 3000
/** While a game runs, installs are rare and the game deserves the I/O. */
const POLL_IN_GAME_MS = 15000

interface WatcherOptions {
  steam: SteamDetection
  heroic: HeroicDetection
  /** True while a game is running - polling slows down then. */
  isGameRunning: () => boolean
  /** True for installs OmniLauncher itself is running - those report their own progress. */
  isTracked: (gameId: string) => boolean
  onLibraryChanged: () => void
  onProgress: (evt: InstallProgressEvent) => void
}

/** Heroic's per-store "what's installed" files - they change on every install/uninstall,
 *  whether it happened in Heroic or here. */
function heroicInstalledFiles(det: HeroicDetection): string[] {
  if (!det.configDir) return []
  return [
    join(det.configDir, 'gog_store', 'installed.json'),
    join(det.configDir, 'legendaryConfig', 'legendary', 'installed.json'),
    join(det.configDir, 'nile_config', 'nile', 'installed.json')
  ]
}

function steamAppIds(steamRoot: string): string[] {
  const ids: string[] = []
  for (const lib of readLibraryFolders(steamRoot)) {
    try {
      for (const name of readdirSync(join(lib, 'steamapps'))) {
        const m = name.match(/^appmanifest_(\d+)\.acf$/)
        if (m) ids.push(m[1])
      }
    } catch {
      // library folder on an unmounted drive - skip it
    }
  }
  return ids
}

/**
 * Notices installs and uninstalls made anywhere - in Steam, in Heroic, or here - and keeps
 * the library in step without a manual rescan. Also reports progress for Steam downloads
 * OmniLauncher didn't start, the same way it does for its own (live bytes on disk against
 * the manifest's totals - see installSteamGame), so they show on the Downloads page too.
 */
export function startLibraryWatcher(opts: WatcherOptions): void {
  const { steam, heroic } = opts
  let lastSignature: string | null = null
  let refreshTimer: NodeJS.Timeout | null = null
  const external = new Map<string, number>() // steam appId -> best progress fraction so far

  const tick = (): void => {
    const parts: string[] = []
    const downloading = new Set<string>()

    if (steam.root) {
      for (const appId of steamAppIds(steam.root)) {
        const state = readSteamInstallState(steam.root, appId)
        if (!state) continue
        parts.push(`${appId}:${state.fullyInstalled ? 1 : 0}`)

        const active =
          !state.fullyInstalled &&
          state.bytesToDownload > 0 &&
          existsSync(join(state.libPath, 'steamapps', 'downloading', appId))
        const gameId = `steam:${appId}`
        if (!active || opts.isTracked(gameId)) continue
        downloading.add(appId)

        let fraction = state.bytesDownloaded / state.bytesToDownload
        if (state.bytesToStage > 0) {
          fraction = Math.max(
            fraction,
            measureSteamDownloadBytes(state.libPath, appId) / state.bytesToStage
          )
        }
        const best = Math.max(external.get(appId) ?? 0, Math.min(fraction, 0.999))
        external.set(appId, best)
        opts.onProgress({
          gameId,
          phase: 'downloading',
          percent: best * 100,
          downloadedBytes: best * state.bytesToDownload,
          totalBytes: state.bytesToDownload,
          external: true
        })
      }
    }
    // A Steam download that stopped being active either finished or was cancelled/removed.
    for (const appId of [...external.keys()]) {
      if (downloading.has(appId)) continue
      external.delete(appId)
      const state = steam.root ? readSteamInstallState(steam.root, appId) : null
      opts.onProgress({
        gameId: `steam:${appId}`,
        phase: state?.fullyInstalled ? 'done' : 'cancelled',
        percent: state?.fullyInstalled ? 100 : undefined,
        external: true
      })
    }

    for (const file of heroicInstalledFiles(heroic)) {
      try {
        parts.push(`${file}:${statSync(file).mtimeMs}`)
      } catch {
        parts.push(`${file}:-`)
      }
    }

    const signature = parts.sort().join('|')
    if (lastSignature !== null && signature !== lastSignature) {
      // Debounced: an install/uninstall touches several files in quick succession.
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        opts.onLibraryChanged()
      }, 1500)
    }
    lastSignature = signature
  }

  const loop = (): void => {
    tick()
    setTimeout(loop, opts.isGameRunning() ? POLL_IN_GAME_MS : POLL_MS)
  }
  loop()
}
