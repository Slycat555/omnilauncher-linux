import { execFile } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { runnerEnv, type HeroicDetection } from './detect'

const execFileP = promisify(execFile)

/**
 * `store_cache/gog_library.json` (read by readGogLibrary in heroic.ts) is not something
 * gogdl itself produces - real Heroic builds it the first time it starts with a
 * logged-in GOG account, by calling GOG's own galaxy-library/gamesdb APIs and caching the
 * result. Logging in through gogdl directly (as this app does, to skip the full Heroic
 * UI) writes valid credentials to auth.json but never triggers that catalog fetch, so the
 * cache file stays missing and the account looks empty in this app until real Heroic is
 * opened once to build it. This replicates that same fetch so login alone is enough.
 */

interface GogCredentials {
  access_token: string
  user_id: string
}

interface GalaxyLibraryEntry {
  platform_id: string
  external_id: string
  certificate: string
}

interface GalaxyLibraryPage {
  items?: GalaxyLibraryEntry[]
  next_page_token?: string
}

interface LocalizedText {
  ['*']?: string
}

interface GamesDbData {
  type: string
  external_id: string
  title?: LocalizedText
  summary?: LocalizedText
  supported_operating_systems?: Array<{ slug: string }>
  game: {
    title?: LocalizedText
    visible_in_library: boolean
    developers?: Array<{ name: string }>
    genres?: Array<{ name?: LocalizedText }>
    logo?: { url_format: string }
    vertical_cover?: { url_format: string }
    background?: { url_format: string }
    icon?: { url_format: string }
    square_icon?: { url_format: string }
  }
}

/** Matches the HeroicCacheGame shape readGogLibrary already parses in heroic.ts. */
interface CachedGogGame {
  app_name: string
  title: string
  art_cover?: string
  art_square?: string
  art_background?: string
  art_icon?: string
  developer?: string
  canRunOffline: boolean
  is_linux_native: boolean
  is_mac_native: boolean
  extra: { about: { description?: string }; genres: string[] }
}

function formatImage(urlFormat: string | undefined, ext: string): string | undefined {
  return urlFormat?.replace('{formatter}', '').replace('{ext}', ext)
}

/**
 * gogdl's `auth` subcommand with no --code returns the currently stored credentials,
 * refreshing the access token first if it's expired - the same thing Heroic's own
 * GOGUser.getCredentials() shells out to gogdl for, instead of reading/refreshing
 * auth.json by hand.
 */
async function getGogCredentials(det: HeroicDetection, authPath: string): Promise<GogCredentials | null> {
  if (!det.gogdlBin) return null
  try {
    const { stdout } = await execFileP(det.gogdlBin, ['--auth-config-path', authPath, 'auth'], {
      env: { ...process.env, ...runnerEnv(det, 'gogdl') }
    })
    const data = JSON.parse(stdout.trim()) as Partial<GogCredentials>
    return data.access_token && data.user_id ? (data as GogCredentials) : null
  } catch {
    return null
  }
}

async function fetchOwnedGogReleases(
  userId: string,
  accessToken: string,
  pageToken?: string
): Promise<GalaxyLibraryEntry[]> {
  const url = new URL(`https://galaxy-library.gog.com/users/${userId}/releases`)
  if (pageToken) url.searchParams.set('page_token', pageToken)
  let page: GalaxyLibraryPage
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return []
    page = (await res.json()) as GalaxyLibraryPage
  } catch {
    return []
  }
  const items = (page.items ?? []).filter((e) => e.platform_id === 'gog')
  if (page.next_page_token) {
    items.push(...(await fetchOwnedGogReleases(userId, accessToken, page.next_page_token)))
  }
  return items
}

async function fetchGogGameInfo(entry: GalaxyLibraryEntry, accessToken: string): Promise<GamesDbData | null> {
  const url = `https://gamesdb.gog.com/platforms/gog/external_releases/${entry.external_id}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, 'X-GOG-Library-Cert': entry.certificate }
    })
    if (!res.ok) return null
    return (await res.json()) as GamesDbData
  } catch {
    return null
  }
}

function toCachedGame(entry: GalaxyLibraryEntry, info: GamesDbData): CachedGogGame | null {
  if (!['game', 'mod'].includes(info.type) || !info.game.visible_in_library) return null
  const background = formatImage(info.game.background?.url_format, 'webp')
  const artCover = formatImage(info.game.logo?.url_format, 'jpg') ?? background
  return {
    app_name: String(info.external_id ?? entry.external_id),
    title: (info.title?.['*'] || info.game.title?.['*'] || '').trim(),
    art_cover: artCover,
    art_square: formatImage(info.game.vertical_cover?.url_format, 'jpg') ?? artCover,
    art_background: background,
    art_icon: formatImage(info.game.square_icon?.url_format ?? info.game.icon?.url_format, 'jpg'),
    developer: info.game.developers?.map((d) => d.name).join(', '),
    canRunOffline: true,
    is_linux_native: !!info.supported_operating_systems?.some((os) => os.slug === 'linux'),
    is_mac_native: !!info.supported_operating_systems?.some((os) => os.slug === 'osx'),
    extra: {
      about: { description: info.summary?.['*'] },
      genres: (info.game.genres ?? []).map((g) => g.name?.['*']).filter((g): g is string => !!g)
    }
  }
}

/** Bounded concurrency so a large library does not fire off hundreds of simultaneous
 *  requests, while still being far faster than the sequential fetch real Heroic does. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Best-effort: on any failure this simply leaves the existing (or missing) cache file
 *  alone, same as a failed live catalog call for Epic falls back to installed-only. */
export async function syncGogLibraryCache(det: HeroicDetection, authPath: string): Promise<void> {
  if (!det.configDir) return
  const creds = await getGogCredentials(det, authPath)
  if (!creds) return
  const releases = await fetchOwnedGogReleases(creds.user_id, creds.access_token)
  if (releases.length === 0) return
  const infos = await mapWithConcurrency(releases, 5, (entry) =>
    fetchGogGameInfo(entry, creds.access_token).then((info) => (info ? toCachedGame(entry, info) : null))
  )
  const games = infos.filter((g): g is CachedGogGame => g !== null)
  const cacheFile = join(det.configDir, 'store_cache', 'gog_library.json')
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, JSON.stringify({ games }))
}
