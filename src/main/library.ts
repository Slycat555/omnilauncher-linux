import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { UnifiedGame } from '../shared/types'
import { loadSettings } from './config'
import { detectAll, detectHeroic, detectSteam, type HeroicDetection, type SteamDetection } from './clients/detect'
import { readHeroicLibrary } from './clients/heroic'
import { readSteamLibrary } from './clients/steam'
import { libraryCacheFilePath } from './paths'
import { isRunning } from './launchManager'
import { installManager } from './installManager'

let steamDetCache: SteamDetection | null = null
let heroicDetCache: HeroicDetection | null = null

export async function getRuntimeDetections(): Promise<{ steam: SteamDetection; heroic: HeroicDetection }> {
  if (!steamDetCache) steamDetCache = await detectSteam()
  if (!heroicDetCache) heroicDetCache = await detectHeroic()
  return { steam: steamDetCache, heroic: heroicDetCache }
}

export function invalidateDetectionCache(): void {
  steamDetCache = null
  heroicDetCache = null
}

export interface LibraryRefreshResult {
  games: UnifiedGame[]
  warnings: string[]
}

export async function refreshLibrary(): Promise<LibraryRefreshResult> {
  const { steam, heroic } = await getRuntimeDetections()
  const settings = loadSettings()
  const [steamResult, heroicGames] = await Promise.all([
    readSteamLibrary(steam, { apiKey: settings.steamWebApiKey, steamId64: settings.steamId64 }),
    readHeroicLibrary(heroic)
  ])
  const games = [...steamResult.games, ...heroicGames].map((g) => ({
    ...g,
    isInstalling: installManager.isBusy(g.id),
    canLaunch: g.canLaunch && !isRunning(g.id)
  }))
  persistCache(games)
  const warnings = steamResult.warning ? [steamResult.warning] : []
  return { games, warnings }
}

export function getCachedLibrary(): UnifiedGame[] {
  const file = libraryCacheFilePath()
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as UnifiedGame[]
  } catch {
    return []
  }
}

function persistCache(games: UnifiedGame[]): void {
  try {
    writeFileSync(libraryCacheFilePath(), JSON.stringify(games))
  } catch {
    // non-fatal: cache is only a startup speedup
  }
}

export { detectAll }
