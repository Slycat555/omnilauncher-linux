import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ControllerMode, UnifiedGame } from '../shared/types'
import { appConfigDir } from './paths'

/**
 * Whether a game actually supports controllers - so "Automatic" can hand it an Xbox pad
 * when it does, and keyboard + mouse when it doesn't (Papers, Please, Field of Glory II,
 * Mount & Blade: Warband...), the way Steam picks a layout per game.
 *
 * GOG lists "Controller support" among a game's features; the Steam store's categories
 * ("Full"/"Partial Controller Support") are the fallback, and the source for Epic/Amazon
 * games, found by title (and the cross-check for a GOG "no"). Answers are cached; an unknown answer means gamepad (nothing
 * worse than before) and is retried next launch.
 */

export interface ControllerSupport {
  supported: boolean
  source: 'gog' | 'steam'
  checkedAt: number
}

const RECHECK_MS = 30 * 24 * 60 * 60 * 1000
/** Steam store categories: 28 Full Controller Support, 18 Partial Controller Support. */
const STEAM_CONTROLLER_CATEGORIES = new Set([18, 28])

function cacheFile(): string {
  return join(appConfigDir(), 'controller-support.json')
}

function readCache(): Record<string, ControllerSupport> {
  try {
    return JSON.parse(readFileSync(cacheFile(), 'utf-8')) as Record<string, ControllerSupport>
  } catch {
    return {}
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fromGog(productId: string): Promise<boolean> {
  const body = (await fetchJson(`https://api.gog.com/v2/games/${productId}?locale=en-US`)) as {
    _embedded?: { features?: { id?: string; name?: string }[] }
  }
  const features = body._embedded?.features
  if (!features) throw new Error('no GOG data')
  return features.some(
    (f) => f.id === 'controller_support' || /controller support/i.test(f.name ?? '')
  )
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

async function steamCategories(appId: string): Promise<number[]> {
  const body = (await fetchJson(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=categories`
  )) as Record<string, { success?: boolean; data?: { categories?: { id: number }[] } }>
  const entry = body[appId]
  if (!entry?.success) throw new Error('no Steam data')
  return (entry.data?.categories ?? []).map((c) => c.id)
}

async function fromSteamByTitle(title: string): Promise<boolean> {
  const params = new URLSearchParams({ term: title, cc: 'us', l: 'english' })
  const body = (await fetchJson(`https://store.steampowered.com/api/storesearch/?${params}`)) as {
    items?: { id: number; name: string }[]
  }
  const want = normalizeTitle(title)
  const match = (body.items ?? []).find((i) => normalizeTitle(i.name) === want)
  if (!match) throw new Error('not on Steam')
  const categories = await steamCategories(String(match.id))
  return categories.some((c) => STEAM_CONTROLLER_CATEGORIES.has(c))
}

async function lookup(game: UnifiedGame): Promise<ControllerSupport | null> {
  // GOG's list misses some (FlatOut 2 plays fine on a pad; only Steam says so), so a
  // "no" from GOG is checked against Steam - either store saying yes counts.
  let gog: boolean | null = null
  if (game.store === 'gog') gog = await fromGog(game.appId).catch(() => null)
  if (gog) return { supported: true, source: 'gog', checkedAt: Date.now() }
  const steam = await fromSteamByTitle(game.title).catch(() => null)
  if (steam !== null) return { supported: steam, source: 'steam', checkedAt: Date.now() }
  return gog === null ? null : { supported: gog, source: 'gog', checkedAt: Date.now() }
}

/** Cached answer, refreshed when stale; null when no store could say. */
export async function getControllerSupport(game: UnifiedGame): Promise<ControllerSupport | null> {
  const cache = readCache()
  const cached = cache[game.id]
  if (cached && Date.now() - cached.checkedAt < RECHECK_MS) return cached
  const fresh = await lookup(game)
  if (!fresh) return cached ?? null
  cache[game.id] = fresh
  try {
    writeFileSync(cacheFile(), JSON.stringify(cache, null, 2))
  } catch {
    // non-fatal: looked up again next time
  }
  return fresh
}

/** What "Automatic" means for this game. */
export async function detectControllerMode(game: UnifiedGame): Promise<{
  mode: ControllerMode
  support: ControllerSupport | null
}> {
  const support = await getControllerSupport(game)
  return { mode: support && !support.supported ? 'kbm' : 'gamepad', support }
}
