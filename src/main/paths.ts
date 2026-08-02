import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export function existsOrNull(p: string): string | null {
  return existsSync(p) ? p : null
}

/** ~/.config/omnilauncher-linux (kept separate from Electron's userData so it's easy to find) */
export function appConfigDir(): string {
  return join(homedir(), '.config', 'omnilauncher-linux')
}

/** Kept under the same visible ~/.config/omnilauncher-linux tree as everything else, not
 *  Electron's internal userData cache, so downloaded art is easy for the user to find. */
export function coversCacheDir(): string {
  return join(appConfigDir(), 'covers')
}

export function coverGameDir(gameId: string): string {
  return join(coversCacheDir(), gameId.replace(/[^a-zA-Z0-9_.-]/g, '_'))
}

export function settingsFilePath(): string {
  return join(appConfigDir(), 'settings.json')
}

export function libraryCacheFilePath(): string {
  return join(appConfigDir(), 'library-cache.json')
}

export function playtimeFilePath(): string {
  return join(appConfigDir(), 'playtime.json')
}
