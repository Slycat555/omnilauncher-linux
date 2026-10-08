import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { UnifiedGame } from '../shared/types'
import { appConfigDir } from './paths'

/**
 * Test build: the library shows a Steam game only when Steam is actually what it's for -
 * it's installed, and it's either multiplayer (where Steam's servers, friends and lobbies
 * matter) or not sold on GOG at all. Everything else is better off as its DRM-free GOG
 * copy, run without Steam.
 *
 * Decisions are cached per app in steam-filter.json; a lookup that fails (offline, rate
 * limited) shows the game and is retried on the next refresh.
 */

/** Steam store categories that mean multiplayer: Multi-player, Co-op, MMO, Shared/Split
 *  Screen, Cross-Platform Multiplayer, Online/LAN/Split Screen PvP and Co-op, PvP. */
const MULTIPLAYER_CATEGORIES = new Set([1, 9, 20, 24, 27, 36, 37, 38, 39, 47, 48, 49])

interface Decision {
  keep: boolean
  reason: 'multiplayer' | 'steam-exclusive' | 'on-gog'
  checkedAt: number
}

/** Re-checked now and then - a game can launch on GOG (or gain multiplayer) later. */
const RECHECK_MS = 30 * 24 * 60 * 60 * 1000

function cacheFile(): string {
  return join(appConfigDir(), 'steam-filter.json')
}

function readCache(): Record<string, Decision> {
  try {
    return JSON.parse(readFileSync(cacheFile(), 'utf-8')) as Record<string, Decision>
  } catch {
    return {}
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function isMultiplayer(appId: string): Promise<boolean> {
  const body = (await fetchJson(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=categories`
  )) as Record<string, { success?: boolean; data?: { categories?: { id: number }[] } }>
  const entry = body[appId]
  if (!entry?.success) throw new Error('no store data')
  return (entry.data?.categories ?? []).some((c) => MULTIPLAYER_CATEGORIES.has(c.id))
}

/** "DARK SOULS™ II: Scholar of the First Sin" -> "dark souls ii scholar of the first sin",
 *  with edition suffixes dropped so "Fallout 3 - Game of the Year Edition" matches GOG's
 *  "Fallout 3: Game of the Year Edition" and plain "Fallout 3" alike. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(
      /\b(game of the year|goty|definitive|enhanced|complete|remastered|deluxe|ultimate|anniversary)( edition)?\b/g,
      ''
    )
    .replace(/\bedition\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function isOnGog(title: string): Promise<boolean> {
  const params = new URLSearchParams({
    query: `like:${title}`,
    limit: '10',
    productType: 'in:game,pack'
  })
  const body = (await fetchJson(`https://catalog.gog.com/v1/catalog?${params}`)) as {
    products?: { title: string }[]
  }
  const want = normalizeTitle(title)
  return (body.products ?? []).some((p) => normalizeTitle(p.title) === want)
}

async function decide(game: UnifiedGame): Promise<Decision | null> {
  try {
    if (await isMultiplayer(game.appId)) {
      return { keep: true, reason: 'multiplayer', checkedAt: Date.now() }
    }
    const onGog = await isOnGog(game.title)
    return { keep: !onGog, reason: onGog ? 'on-gog' : 'steam-exclusive', checkedAt: Date.now() }
  } catch {
    return null
  }
}

/** Drops Steam games that don't belong in this build's library; other stores pass. */
export async function filterSteamGames(games: UnifiedGame[]): Promise<UnifiedGame[]> {
  const cache = readCache()
  const steam = games.filter((g) => g.store === 'steam' && (g.isInstalled || g.isInstalling))
  const stale = steam.filter((g) => {
    const d = cache[g.appId]
    return !d || Date.now() - d.checkedAt > RECHECK_MS
  })

  // A few at a time - the store API rate-limits bursts.
  let changed = false
  for (let i = 0; i < stale.length; i += 4) {
    const batch = stale.slice(i, i + 4)
    const results = await Promise.all(batch.map(decide))
    results.forEach((d, j) => {
      if (!d) return
      cache[batch[j].appId] = d
      changed = true
    })
  }
  if (changed) {
    try {
      writeFileSync(cacheFile(), JSON.stringify(cache, null, 2))
    } catch {
      // non-fatal: just re-checked next time
    }
  }

  return games.filter((g) => {
    if (g.store !== 'steam') return true
    // Downloads stay visible until they finish, so they can be followed and cancelled.
    if (g.isInstalling) return true
    if (!g.isInstalled) return false
    return cache[g.appId]?.keep ?? true
  })
}
