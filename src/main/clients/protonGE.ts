import { execFile } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { InstallProgressEvent } from '../../shared/types'
import { appConfigDir } from '../paths'

const execFileP = promisify(execFile)

const RELEASES_URL = 'https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/latest'

/**
 * Never written into Steam's own data directory - only findInstalledProton() reads
 * that (compatibilitytools.d, steamapps/common). This is the app's own, so a runtime it
 * downloads is never mistaken for one the user installed themselves and is trivial to
 * wipe (Settings > uninstall) without touching anything Steam manages.
 */
export function compatToolsDir(): string {
  return join(appConfigDir(), 'compat-tools')
}

interface GitHubAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GitHubRelease {
  tag_name: string
  assets: GitHubAsset[]
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`)
  return (await res.json()) as GitHubRelease
}

/** Streams the response body to disk, respecting backpressure (a multi-hundred-MB
 *  tarball written faster than disk can take it would otherwise pile the whole thing
 *  up in memory) and reporting bytes-so-far as it goes. */
async function downloadToFile(
  url: string,
  destPath: string,
  onBytes: (bytesDone: number) => void
): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`)
  const writeStream = createWriteStream(destPath)
  const reader = res.body.getReader()
  let bytesDone = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    bytesDone += value.byteLength
    onBytes(bytesDone)
    if (!writeStream.write(value)) {
      await new Promise<void>((resolve) => writeStream.once('drain', resolve))
    }
  }
  await new Promise<void>((resolve, reject) => {
    writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })
}

type ProgressCb = (evt: InstallProgressEvent) => void

/**
 * Downloads and extracts the latest GE-Proton release, the same runtime real Heroic
 * itself defaults to fetching (via its "Wine Manager") the first time a Windows title is
 * launched with nothing configured - replicated here so this app does not instead
 * dead-end on "go configure a runtime in Heroic first" (the exact bug reported). Only
 * called once resolveWineForGame() has already confirmed nothing usable exists yet
 * (neither Heroic-configured nor an existing Steam/GE-Proton install), and the result
 * lands where findInstalledProton() looks for it, so every later launch (of any game)
 * finds it instantly with no further downloads.
 */
export async function downloadLatestGEProton(
  gameId: string,
  onProgress: ProgressCb
): Promise<{ bin: string; version: string } | null> {
  try {
    onProgress({ gameId, phase: 'starting', message: 'Looking up latest Proton-GE release' })
    const release = await fetchLatestRelease()
    const asset = release.assets.find((a) => a.name.endsWith('.tar.gz'))
    if (!asset) {
      onProgress({ gameId, phase: 'error', message: 'No Proton-GE release asset found' })
      return null
    }

    const destRoot = compatToolsDir()
    mkdirSync(destRoot, { recursive: true })
    const finalDir = join(destRoot, release.tag_name)
    const finalBin = join(finalDir, 'proton')
    if (existsSync(finalBin)) {
      onProgress({ gameId, phase: 'done', percent: 100, message: `${release.tag_name} already installed` })
      return { bin: finalBin, version: release.tag_name }
    }

    const tmpFile = join(destRoot, `${release.tag_name}.tar.gz.part`)
    onProgress({
      gameId,
      phase: 'downloading',
      message: `Downloading ${release.tag_name}`,
      bytesTotal: asset.size,
      percent: 0
    })
    await downloadToFile(asset.browser_download_url, tmpFile, (bytesDone) => {
      onProgress({
        gameId,
        phase: 'downloading',
        bytesDone,
        bytesTotal: asset.size,
        percent: asset.size ? Math.min(100, (bytesDone / asset.size) * 100) : undefined
      })
    })

    onProgress({ gameId, phase: 'installing', message: `Extracting ${release.tag_name}` })
    try {
      await execFileP('tar', ['-xzf', tmpFile, '-C', destRoot])
    } finally {
      rmSync(tmpFile, { force: true })
    }

    if (!existsSync(finalBin)) {
      onProgress({ gameId, phase: 'error', message: 'Extraction did not produce a usable Proton install' })
      rmSync(finalDir, { recursive: true, force: true })
      return null
    }
    onProgress({ gameId, phase: 'done', percent: 100, message: `${release.tag_name} ready` })
    return { bin: finalBin, version: release.tag_name }
  } catch (err) {
    onProgress({
      gameId,
      phase: 'error',
      message: err instanceof Error ? err.message : 'Failed to download Proton-GE'
    })
    return null
  }
}
