import { execFile } from 'child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type { GamePlatform, StoreKind, UnifiedGame } from '../../shared/types'
import {
  gogdlManifestPath,
  heroicDefaultInstallPath,
  legendaryInstalledJsonPath,
  runnerEnv,
  type HeroicDetection
} from './detect'

const execFileP = promisify(execFile)

// ---------- generic helpers ----------

function readJsonSafe<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

async function runJson<T>(
  bin: string | null,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20000
): Promise<T | null> {
  if (!bin) return null
  try {
    const { stdout } = await execFileP(bin, args, {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024
    })
    return JSON.parse(stdout) as T
  } catch {
    return null
  }
}

export function sanitizeFolderName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '').trim() || 'game'
}

// ---------- catalog cache shapes (Heroic's own store_cache files) ----------

interface HeroicCacheGame {
  app_name: string
  title: string
  is_installed?: boolean
  art_cover?: string
  art_square?: string
  art_background?: string
  art_icon?: string
  developer?: string
  canRunOffline?: boolean
  is_linux_native?: boolean
  is_mac_native?: boolean
  install?: {
    is_dlc?: boolean
    install_path?: string
    platform?: string
    executable?: string
  }
  extra?: {
    about?: { description?: string; shortDescription?: string }
    genres?: string[]
  }
}

interface GogInstalledEntry {
  appName: string
  install_path: string
  install_size?: string
  platform?: string
}

function platformFrom(raw: string | undefined, isLinuxNative: boolean | undefined): GamePlatform {
  if (isLinuxNative) return 'linux'
  if (raw === 'osx' || raw === 'mac') return 'mac'
  if (raw === 'linux') return 'linux'
  return 'windows'
}

function toUnified(
  store: StoreKind,
  g: HeroicCacheGame,
  installed: boolean,
  installPath: string | undefined,
  canRun: boolean,
  /** Platform actually installed on disk, which can differ from what the game supports. */
  platformOverride?: GamePlatform
): UnifiedGame {
  const desc = g.extra?.about?.description || g.extra?.about?.shortDescription
  return {
    id: `${store}:${g.app_name}`,
    store,
    appId: g.app_name,
    title: g.title,
    isInstalled: installed,
    isInstalling: false,
    installPath,
    coverUrl: g.art_square || g.art_cover,
    heroUrl: g.art_background || g.art_cover,
    logoUrl: g.art_icon,
    description: desc,
    genres: g.extra?.genres,
    developer: g.developer,
    platform: platformOverride ?? platformFrom(g.install?.platform, g.is_linux_native),
    canLaunch: installed && canRun,
    canInstall: !installed && canRun,
    canUninstall: installed
  }
}

// ---------- GOG ----------

export async function readGogLibrary(det: HeroicDetection): Promise<UnifiedGame[]> {
  if (!det.configDir) return []
  const cache = readJsonSafe<{ games: HeroicCacheGame[] }>(
    join(det.configDir, 'store_cache', 'gog_library.json')
  )
  if (!cache?.games) return []
  const installedList =
    readJsonSafe<{ installed: GogInstalledEntry[] }>(
      join(det.configDir, 'gog_store', 'installed.json')
    )?.installed ?? []
  const installedMap = new Map(installedList.map((e) => [e.appName, e]))

  return cache.games
    .filter((g) => !g.install?.is_dlc && g.app_name !== 'gog-redist')
    .map((g) => {
      const inst = installedMap.get(g.app_name)
      const path = inst?.install_path ?? g.install?.install_path
      // Trust the files on disk over the bookkeeping: a game deleted outside Heroic
      // would otherwise keep showing a Play button that cannot work.
      const installed = !!path && existsSync(path)
      // A title can ship a Linux build yet have had its Windows build installed (we always
      // request --platform windows), so launch based on what is actually on disk.
      const installedPlatform = installed
        ? platformFrom(inst?.platform ?? g.install?.platform, false)
        : undefined
      return toUnified('gog', g, installed, installed ? path : undefined, !!det.gogdlBin, installedPlatform)
    })
}

/** gogdl needs to be told explicitly where Heroic keeps the GOG login tokens - it
 *  does not fall back to any XDG/env-based default. */
function gogAuthConfigPath(det: HeroicDetection): string | null {
  if (!det.configDir) return null
  const p = join(det.configDir, 'gog_store', 'auth.json')
  return existsSync(p) ? p : null
}

function gogInstalledFilePath(det: HeroicDetection): string | null {
  return det.configDir ? join(det.configDir, 'gog_store', 'installed.json') : null
}

/**
 * We install/uninstall GOG games ourselves via gogdl (bypassing Heroic's own UI), so
 * Heroic never learns about it. Write straight into Heroic's own bookkeeping file -
 * this is the single source of truth `readGogLibrary` (and Heroic itself) reads from.
 */
export function markGogInstalled(
  det: HeroicDetection,
  appId: string,
  installPath: string,
  platform: 'windows' | 'linux'
): void {
  const file = gogInstalledFilePath(det)
  if (!file) return
  const data = readJsonSafe<{ installed: GogInstalledEntry[] }>(file) ?? { installed: [] }
  const entry: GogInstalledEntry = {
    appName: appId,
    install_path: installPath,
    platform
  }
  data.installed = [...data.installed.filter((e) => e.appName !== appId), entry]
  writeFileSync(file, JSON.stringify(data, null, '\t'))
}

export function unmarkGogInstalled(det: HeroicDetection, appId: string): void {
  const file = gogInstalledFilePath(det)
  if (!file) return
  const data = readJsonSafe<{ installed: GogInstalledEntry[] }>(file)
  if (!data) return
  data.installed = data.installed.filter((e) => e.appName !== appId)
  writeFileSync(file, JSON.stringify(data, null, '\t'))
}

export function buildGogInstallCommand(
  det: HeroicDetection,
  game: UnifiedGame
): { bin: string; args: string[]; env: NodeJS.ProcessEnv; installPath: string } | null {
  if (!det.gogdlBin) return null
  const auth = gogAuthConfigPath(det)
  if (!auth) return null
  // Installs into Heroic's own configured default library, not a separate app-owned
  // directory - see heroicDefaultInstallPath's doc comment for why that split caused
  // real Heroic to show these exact titles as "Game not available".
  const target = join(heroicDefaultInstallPath(det), 'GOG', sanitizeFolderName(game.title))
  return {
    bin: det.gogdlBin,
    args: [
      '--auth-config-path',
      auth,
      'download',
      game.appId,
      '--path',
      target,
      '--platform',
      'windows'
    ],
    env: runnerEnv(det, 'gogdl'),
    installPath: target
  }
}

interface GogPlayTask {
  isPrimary?: boolean
  type: string
  path: string
}

interface GogGameInfo {
  gameId: string
  playTasks: GogPlayTask[]
}

/**
 * GOG manifests are authored on Windows, so the recorded path casing often does not match
 * what is on disk (e.g. "checkapplication.exe" vs the real "CheckApplication.exe"). Resolve
 * each path segment case-insensitively so launching works on a case-sensitive filesystem.
 */
function resolveCaseInsensitive(baseDir: string, relativePath: string): string | null {
  const segments = relativePath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.')
  let current = baseDir
  for (const segment of segments) {
    const direct = join(current, segment)
    if (existsSync(direct)) {
      current = direct
      continue
    }
    let match: string | undefined
    try {
      match = readdirSync(current).find((e) => e.toLowerCase() === segment.toLowerCase())
    } catch {
      return null
    }
    if (!match) return null
    current = join(current, match)
  }
  return current
}

/** Finds the primary launch executable by reading GOG's own goggame-<id>.info manifest,
 *  the same file Heroic/GOG Galaxy use to know what to run. */
function findGogExecutable(installPath: string, appId: string): string | null {
  const infoCandidates = [
    join(installPath, `goggame-${appId}.info`),
    ...findFilesShallow(installPath, `goggame-${appId}.info`)
  ]
  for (const infoPath of infoCandidates) {
    const info = readJsonSafe<GogGameInfo>(infoPath)
    const tasks = (info?.playTasks ?? []).filter((t) => t.type === 'FileTask' && t.path)
    const ordered = [...tasks.filter((t) => t.isPrimary), ...tasks.filter((t) => !t.isPrimary)]
    for (const task of ordered) {
      const resolved = resolveCaseInsensitive(dirname(infoPath), task.path)
      if (resolved) return resolved
    }
  }
  return null
}

/**
 * gogdl decides what to download by diffing against the build manifest it cached last time.
 * If that manifest survives but the game files are gone (deleted outside Heroic, a cancelled
 * install, a changed install location), it concludes "Nothing to do", downloads nothing and
 * still exits 0. Drop the stale manifest so a fresh install really downloads.
 */
export function clearStaleGogManifest(det: HeroicDetection, appId: string): void {
  const manifest = gogdlManifestPath(det, appId)
  if (!manifest) return
  try {
    rmSync(manifest, { force: true })
  } catch {
    // best effort: a surviving manifest only means gogdl may skip the download
  }
}

function findFilesShallow(root: string, filename: string): string[] {
  const found: string[] = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const p = join(root, entry.name, filename)
        if (existsSync(p)) found.push(p)
      }
    }
  } catch {
    // ignore unreadable install dirs
  }
  return found
}

/**
 * gogdl's own `launch` subcommand exits immediately with no output in this environment
 * (a known issue independent of our integration - reproduced by invoking the exact same
 * binary directly outside Heroic too). Proton/Wine themselves work fine, so we invoke the
 * resolved runtime directly against GOG's own play-task executable instead of going
 * through gogdl for this one step.
 */
export function buildGogLaunchCommand(
  det: HeroicDetection,
  game: UnifiedGame,
  wine: { bin: string; prefix: string; type: string } | null,
  steamInstallPath: string | null
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (!game.installPath) return null
  const exe = findGogExecutable(game.installPath, game.appId)
  if (!exe || !existsSync(exe)) return null

  if (game.platform === 'linux') {
    return { bin: exe, args: [], env: det.env }
  }

  if (!wine) return null
  if (wine.type === 'proton') {
    return {
      bin: wine.bin,
      args: ['run', exe],
      env: {
        ...det.env,
        STEAM_COMPAT_DATA_PATH: wine.prefix,
        ...(steamInstallPath ? { STEAM_COMPAT_CLIENT_INSTALL_PATH: steamInstallPath } : {})
      }
    }
  }
  return {
    bin: wine.bin,
    args: [exe],
    env: { ...det.env, WINEPREFIX: wine.prefix }
  }
}

// ---------- Epic ----------

/**
 * Shape of `legendary list --json` - Epic's raw catalog entry, NOT Heroic's flattened
 * store_cache format (that only exists once Heroic itself has fetched+cached it). This
 * has `app_title`/`metadata.*` instead of `title`/`art_cover`; reusing `HeroicCacheGame`
 * here silently produced `title: undefined` for every Epic game, which crashed the
 * renderer the moment anything called `.toLowerCase()` on it (search filter, sort).
 */
interface LegendaryListEntry {
  app_name: string
  app_title: string
  metadata?: {
    developer?: string
    description?: string
    keyImages?: Array<{ type: string; url: string }>
  }
}

function legendaryImage(entry: LegendaryListEntry, type: string): string | undefined {
  return entry.metadata?.keyImages?.find((img) => img.type === type)?.url
}

interface LegendaryInstalledEntry {
  app_name: string
  title: string
  install_path: string
}

/** Built straight from legendary's own installed.json, with no cover art or catalog
 *  metadata (that only comes from the live `list` call) - used when that call fails, so
 *  an installed game the user can actually still launch never just vanishes because of
 *  a slow/failed network request or an expired login. */
function installedOnlyEpicGames(det: HeroicDetection): UnifiedGame[] {
  const path = legendaryInstalledJsonPath(det)
  const data = path ? readJsonSafe<Record<string, LegendaryInstalledEntry>>(path) : null
  if (!data) return []
  return Object.values(data).map(
    (g) =>
      ({
        id: `epic:${g.app_name}`,
        store: 'epic',
        appId: g.app_name,
        title: g.title,
        isInstalled: true,
        isInstalling: false,
        installPath: g.install_path,
        platform: 'windows',
        canLaunch: true,
        canInstall: false,
        canUninstall: true
      }) satisfies UnifiedGame
  )
}

export async function readEpicLibrary(det: HeroicDetection): Promise<UnifiedGame[]> {
  if (!det.legendaryBin) return []
  const legendaryEnv = runnerEnv(det, 'legendary')
  // The default 20s timeout is tight for this call specifically - it fetches full
  // catalog metadata for every owned game from Epic's API, which is slow on a large
  // library or a fresh login with nothing cached yet.
  const owned = await runJson<LegendaryListEntry[]>(
    det.legendaryBin,
    ['list', '--json'],
    legendaryEnv,
    60000
  )
  // `list` needs a live, successful call to Epic's API - a slow network, an expired
  // session, or just a timeout on a big catalog all make it fail. Falling back to []
  // used to make even already-installed games disappear entirely; fall back to what
  // legendary's own local install records say instead, so those keep showing.
  if (!owned) return installedOnlyEpicGames(det)
  const installed = await runJson<Array<{ app_name: string; install_path: string }>>(
    det.legendaryBin,
    ['list-installed', '--json'],
    legendaryEnv
  )
  const installedMap = new Map((installed ?? []).map((e) => [e.app_name, e]))
  return owned
    .filter((g) => g.app_name && g.app_title)
    .map((g) => {
      const inst = installedMap.get(g.app_name)
      const installed = !!inst
      return {
        id: `epic:${g.app_name}`,
        store: 'epic',
        appId: g.app_name,
        title: g.app_title,
        isInstalled: installed,
        isInstalling: false,
        installPath: inst?.install_path,
        coverUrl: legendaryImage(g, 'DieselGameBoxTall'),
        heroUrl: legendaryImage(g, 'DieselGameBox'),
        description: g.metadata?.description,
        developer: g.metadata?.developer,
        platform: 'windows',
        canLaunch: installed,
        canInstall: !installed,
        canUninstall: installed
      } satisfies UnifiedGame
    })
}

export function buildEpicInstallCommand(
  det: HeroicDetection,
  game: UnifiedGame
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (!det.legendaryBin) return null
  // Installs into Heroic's own configured default library, not a separate app-owned
  // directory - see heroicDefaultInstallPath's doc comment for why that split caused
  // real Heroic to show these exact titles as "Game not available".
  return {
    bin: det.legendaryBin,
    args: ['-y', 'install', game.appId, '--base-path', join(heroicDefaultInstallPath(det), 'Epic')],
    env: runnerEnv(det, 'legendary')
  }
}

/**
 * Launches through `legendary launch` itself, not by resolving the installed exe and
 * invoking Proton/Wine on it directly - a real, confirmed bug in the previous approach:
 * legendary builds a full Epic Online Services auth line for the launch (-AUTH_LOGIN,
 * -AUTH_TYPE=exchangecode, -epicapp, -epicusername, -epicuserid, -epicsandboxid, ...),
 * derived from the real logged-in session, that a bare "run the exe" invocation never
 * supplied at all. Confirmed directly against this exact install (Rocket League, which
 * requires Epic Online Services + Easy Anti-Cheat to hand off from its Launcher.exe
 * bootstrap to the real game) via `legendary launch <appid> --dry-run`: titles with no
 * EOS/anti-cheat dependency (Cuphead) happened to launch fine without that auth line,
 * but Rocket League's EAC/EOS handoff silently failed without it - exactly the "click
 * install/play should work exactly like it does natively" gap.
 *
 * legendary's `--wine <proton>` flag substitutes the given binary directly as the
 * executable (`<bin> <exe> <args>`, with WINEPREFIX env) - not a valid Proton
 * invocation, since Proton requires a verb (run/waitforexitandrun) as its first
 * argument and reads STEAM_COMPAT_* vars, not WINEPREFIX. `--no-wine --wrapper "<proton
 * path> run"` is the correct way to get Proton launched by legendary itself instead:
 * verified via dry-run that this produces exactly `<proton> run <exe> <same real auth
 * args>` - legendary treats the wrapper as a literal prefix to its own command line,
 * so the full real launch parameters (with working directory, if the version
 * eventually surfaces it) still come from legendary, not reconstructed by hand.
 */
export function buildEpicLaunchCommand(
  det: HeroicDetection,
  game: UnifiedGame,
  wine: { bin: string; prefix: string; type: string } | null,
  steamInstallPath: string | null
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (!det.legendaryBin) return null

  if (game.platform === 'linux') {
    return { bin: det.legendaryBin, args: ['launch', game.appId], env: runnerEnv(det, 'legendary') }
  }

  if (!wine) return null
  const legendaryEnv = runnerEnv(det, 'legendary')
  if (wine.type === 'proton') {
    return {
      bin: det.legendaryBin,
      args: ['launch', game.appId, '--no-wine', '--wrapper', `${wine.bin} run`],
      env: {
        ...legendaryEnv,
        STEAM_COMPAT_DATA_PATH: wine.prefix,
        ...(steamInstallPath ? { STEAM_COMPAT_CLIENT_INSTALL_PATH: steamInstallPath } : {})
      }
    }
  }
  return {
    bin: det.legendaryBin,
    args: ['launch', game.appId, '--wine', wine.bin, '--wine-prefix', wine.prefix],
    env: legendaryEnv
  }
}

export function buildEpicUninstallCommand(
  det: HeroicDetection,
  game: UnifiedGame
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (!det.legendaryBin) return null
  return { bin: det.legendaryBin, args: ['-y', 'uninstall', game.appId], env: runnerEnv(det, 'legendary') }
}

// ---------- Amazon ----------

export async function readAmazonLibrary(det: HeroicDetection): Promise<UnifiedGame[]> {
  if (!det.configDir) return []
  const cache = readJsonSafe<HeroicCacheGame[] | { games: HeroicCacheGame[] }>(
    join(det.configDir, 'store_cache', 'nile_library.json')
  )
  const list = Array.isArray(cache) ? cache : cache?.games
  if (!list) return []
  return list.map((g) => toUnified('amazon', g, !!g.is_installed, g.install?.install_path, !!det.nileBin))
}

export function buildAmazonInstallCommand(
  det: HeroicDetection,
  game: UnifiedGame
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (!det.nileBin) return null
  // Installs into Heroic's own configured default library, not a separate app-owned
  // directory - see heroicDefaultInstallPath's doc comment for why that split caused
  // real Heroic to show these exact titles as "Game not available".
  return {
    bin: det.nileBin,
    args: ['install', game.appId, '--base-path', join(heroicDefaultInstallPath(det), 'Amazon')],
    env: runnerEnv(det, 'nile')
  }
}

export function buildAmazonLaunchCommand(
  det: HeroicDetection,
  game: UnifiedGame,
  wine: { bin: string; prefix: string } | null
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (!det.nileBin) return null
  if (game.platform === 'linux') {
    return { bin: det.nileBin, args: ['launch', game.appId, '--no-wine'], env: runnerEnv(det, 'nile') }
  }
  if (!wine) return null
  return {
    bin: det.nileBin,
    args: ['launch', game.appId, '--wine', wine.bin, '--wine-prefix', wine.prefix],
    env: runnerEnv(det, 'nile')
  }
}

export function buildAmazonUninstallCommand(
  det: HeroicDetection,
  game: UnifiedGame
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (!det.nileBin) return null
  return { bin: det.nileBin, args: ['uninstall', game.appId], env: runnerEnv(det, 'nile') }
}

// ---------- Wine/Proton resolution (reuses Heroic's own per-game / default config) ----------

interface HeroicGameConfigFile {
  [appId: string]: {
    winePrefix?: string
    wineVersion?: { bin?: string; type?: string }
  }
}

interface HeroicGlobalConfig {
  defaultSettings?: {
    defaultWinePrefix?: string
    wineVersion?: { bin?: string; type?: string }
  }
}

export function resolveWineForGame(
  det: HeroicDetection,
  appId: string
): { bin: string; prefix: string; type: string } | null {
  if (!det.configDir) return null
  const perGame = readJsonSafe<HeroicGameConfigFile>(
    join(det.configDir, 'GamesConfig', `${appId}.json`)
  )
  const entry = perGame?.[appId]
  if (entry?.wineVersion?.bin && entry?.winePrefix) {
    return { bin: entry.wineVersion.bin, prefix: entry.winePrefix, type: entry.wineVersion.type ?? 'wine' }
  }
  const global = readJsonSafe<HeroicGlobalConfig>(join(det.configDir, 'config.json'))
  const bin = global?.defaultSettings?.wineVersion?.bin
  const prefix = global?.defaultSettings?.defaultWinePrefix
  if (bin && prefix && existsSync(bin)) {
    return { bin, prefix, type: global?.defaultSettings?.wineVersion?.type ?? 'wine' }
  }
  return null
}

export async function readHeroicLibrary(det: HeroicDetection): Promise<UnifiedGame[]> {
  if (!det.present) return []
  const [gog, epic, amazon] = await Promise.all([
    readGogLibrary(det),
    readEpicLibrary(det),
    readAmazonLibrary(det)
  ])
  return [...gog, ...epic, ...amazon]
}
