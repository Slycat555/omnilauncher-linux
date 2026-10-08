import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type { GamePlatform, InstallProgressEvent, StoreKind, UnifiedGame } from '../../shared/types'
import { appConfigDir } from '../paths'
import {
  gogdlManifestPath,
  heroicDefaultInstallPath,
  legendaryInstalledJsonPath,
  runnerEnv,
  type HeroicDetection
} from './detect'
import { gogdl64BitCommand } from './gogdlWrapper'
import { compatToolsDir, downloadLatestGEProton } from './protonGE'
import { hostEnv } from '../hostEnv'

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
      env: hostEnv(env),
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
      return toUnified(
        'gog',
        g,
        installed,
        installed ? path : undefined,
        !!det.gogdlBin,
        installedPlatform
      )
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
  // Through the 64-bit-only wrapper - see gogdlWrapper.ts.
  const runner = gogdl64BitCommand(det.gogdlBin)
  return {
    bin: runner.bin,
    // gogdl's --path is the PARENT folder: it creates the game's own folder (named from
    // GOG's installDirectory) inside it. Passing the game folder itself nested the files
    // one level too deep (GOG/Apotheon/Apotheon) while the install was recorded one level
    // up, so nothing could find the game afterwards. resolveGogInstallDir() finds the
    // folder gogdl actually created once the download is done.
    args: [
      ...runner.prefixArgs,
      '--auth-config-path',
      auth,
      'download',
      game.appId,
      '--path',
      dirname(target),
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

/** The folder a GOG game actually landed in: the one holding its goggame-<id>.info, under
 *  the GOG library folder (gogdl names it after GOG's installDirectory, which can differ
 *  from the store title) - falls back to `expected` when nothing is found. */
export function resolveGogInstallDir(expected: string, appId: string): string {
  const info = `goggame-${appId}.info`
  if (existsSync(join(expected, info))) return expected
  const nested = findFilesShallow(expected, info)[0] ?? findFilesShallow(dirname(expected), info)[0]
  return nested ? dirname(nested) : expected
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
/**
 * The SDL controller mappings Steam has stored (config.vdf "SDL_GamepadBind" - one line per
 * controller, e.g. the 8BitDo Ultimate 2C), passed to non-Steam launches the same way Steam
 * passes them to its own games. Without it, Proton's SDL has no mapping for a controller it
 * doesn't know, exposes it as a generic joystick in raw axis order, and games read the
 * sticks as the wrong axes (horizontal right stick moving the camera vertically, etc.).
 */
function steamControllerMappings(steamRoot: string | null): NodeJS.ProcessEnv {
  if (!steamRoot) return {}
  try {
    const vdf = readFileSync(join(steamRoot, 'config', 'config.vdf'), 'utf-8')
    const binds = vdf.match(/"SDL_GamepadBind"\s+"([^"]*)"/)?.[1]?.trim()
    return binds ? { SDL_GAMECONTROLLERCONFIG: binds } : {}
  } catch {
    return {}
  }
}

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
    // Through umu, exactly like Heroic: it runs Proton inside Valve's Steam Runtime
    // container, which Proton is built for. Running the proton script bare on the host
    // (the fallback below) skips that runtime and can fail to start the game.
    const umu = det.configDir ? join(det.configDir, 'tools', 'runtimes', 'umu', 'umu_run.py') : null
    if (umu && existsSync(umu)) {
      return {
        bin: 'python3',
        args: [umu, exe],
        env: {
          ...det.env,
          WINEPREFIX: wine.prefix,
          PROTONPATH: dirname(wine.bin),
          GAMEID: `umu-${game.appId}`,
          STORE: 'gog',
          ...steamControllerMappings(steamInstallPath)
        }
      }
    }
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
  return {
    bin: det.legendaryBin,
    args: ['-y', 'uninstall', game.appId],
    env: runnerEnv(det, 'legendary')
  }
}

// ---------- Amazon ----------

export async function readAmazonLibrary(det: HeroicDetection): Promise<UnifiedGame[]> {
  if (!det.configDir) return []
  const cache = readJsonSafe<HeroicCacheGame[] | { games: HeroicCacheGame[] }>(
    join(det.configDir, 'store_cache', 'nile_library.json')
  )
  const list = Array.isArray(cache) ? cache : cache?.games
  if (!list) return []
  return list.map((g) =>
    toUnified('amazon', g, !!g.is_installed, g.install?.install_path, !!det.nileBin)
  )
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
    return {
      bin: det.nileBin,
      args: ['launch', game.appId, '--no-wine'],
      env: runnerEnv(det, 'nile')
    }
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
    wineVersion?: { bin?: string; name?: string; type?: string }
  }
}

interface HeroicGlobalConfig {
  defaultSettings?: {
    defaultWinePrefix?: string
    wineVersion?: { bin?: string; type?: string }
  }
}

/**
 * Real Heroic never actually requires the user to hand-configure Wine/Proton before a
 * first launch - it auto-picks (and if needed, downloads) a runtime itself. Reading only
 * Heroic's own per-game/global config replicated the "already configured" half of that,
 * but not the "auto-pick one" half, so a game installed and launched only through this
 * app (Heroic's UI never opened) always hit the "No Wine/Proton configured... Configure
 * it once in Heroic" dead end in launchManager.ts - confirmed as the exact bug reported:
 * a first launch demanding a trip through Heroic's UI first. Checks, in order: an
 * existing Steam-managed Proton (compatibilitytools.d - where ProtonUp-Qt-installed
 * GE-Proton lives - then steamapps/common), then whatever this app previously downloaded
 * itself into compatToolsDir() (see downloadLatestGEProton / resolveOrInstallWineForGame
 * below, which is what actually fetches one the very first time nothing is found here).
 */
function findSteamProton(steamRoot: string | null): { bin: string; version: string } | null {
  const candidateDirs = [
    ...(steamRoot ? [join(steamRoot, 'compatibilitytools.d')] : []), // user-installed (ProtonUp-Qt etc.) - preferred
    ...(steamRoot ? [join(steamRoot, 'steamapps', 'common')] : []), // official Proton versions Steam itself installed
    compatToolsDir() // whatever this app previously downloaded itself (see downloadLatestGEProton)
  ]
  const found: Array<{ bin: string; version: string }> = []
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /proton/i.test(e.name))
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const name of entries.sort().reverse()) {
      const bin = join(dir, name, 'proton')
      if (existsSync(bin)) found.push({ bin, version: name })
    }
    if (found.length > 0) break // prefer compatibilitytools.d entirely over steamapps/common
  }
  return found[0] ?? null
}

/** Prefix for a game this app launched through its own Steam-Proton fallback, since
 *  there is no Heroic-owned prefix to reuse in that case. */
function ownedPrefixDir(store: StoreKind, appId: string): string {
  const dir = join(appConfigDir(), 'prefixes', `${store}-${appId}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveWineForGame(
  det: HeroicDetection,
  store: StoreKind,
  appId: string,
  steamRoot: string | null,
  title?: string
): { bin: string; prefix: string; type: string } | null {
  if (det.configDir) {
    const perGame = readJsonSafe<HeroicGameConfigFile>(
      join(det.configDir, 'GamesConfig', `${appId}.json`)
    )
    const entry = perGame?.[appId]
    if (entry?.wineVersion?.bin && entry?.winePrefix) {
      return {
        bin: entry.wineVersion.bin,
        prefix: entry.winePrefix,
        type: entry.wineVersion.type ?? 'wine'
      }
    }
    const global = readJsonSafe<HeroicGlobalConfig>(join(det.configDir, 'config.json'))
    const bin = global?.defaultSettings?.wineVersion?.bin
    const prefixRoot = global?.defaultSettings?.defaultWinePrefix
    if (bin && prefixRoot && existsSync(bin)) {
      // defaultWinePrefix is the folder Heroic keeps prefixes IN (Prefixes/<Game Title>),
      // not a prefix itself - using it directly put every game into one shared prefix.
      const prefix = join(prefixRoot, sanitizeFolderName(title ?? `${store}-${appId}`))
      return { bin, prefix, type: global?.defaultSettings?.wineVersion?.type ?? 'wine' }
    }
  }
  const proton = findSteamProton(steamRoot)
  if (!proton) return null
  return { bin: proton.bin, prefix: ownedPrefixDir(store, appId), type: 'proton' }
}

/**
 * Same as resolveWineForGame, but when nothing is found anywhere (no Heroic config, no
 * Steam-managed Proton, nothing this app fetched before) it downloads the latest
 * GE-Proton release instead of giving up - this is the piece that makes a first launch
 * "just work" the way it does through real Heroic's own Wine Manager, rather than
 * requiring the user to have ProtonUp-Qt'd a runtime into Steam beforehand. onProgress
 * (optional) gets the same InstallProgressEvent shape/'install:progress' channel the
 * game-install flow already uses, so a download in progress shows the same familiar
 * per-card progress bar instead of a silent multi-minute pause on first launch. */
export async function resolveOrInstallWineForGame(
  det: HeroicDetection,
  store: StoreKind,
  appId: string,
  steamRoot: string | null,
  gameId: string,
  onProgress?: (evt: InstallProgressEvent) => void,
  title?: string
): Promise<{ bin: string; prefix: string; type: string } | null> {
  const existing = resolveWineForGame(det, store, appId, steamRoot, title)
  if (existing) return existing
  const runtime = await downloadLatestGEProton(gameId, onProgress ?? (() => {}))
  if (!runtime) return null
  return { bin: runtime.bin, prefix: ownedPrefixDir(store, appId), type: 'proton' }
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

export interface ProtonBuild {
  /** Folder name, e.g. "proton-10-codecs" or "Proton - Experimental". */
  name: string
  bin: string
}

/** Every Proton build available to GOG/Epic/Amazon games: user-installed
 *  (compatibilitytools.d), Steam's own Proton versions, and anything this app downloaded. */
export function listProtonBuilds(steamRoot: string | null): ProtonBuild[] {
  const dirs = [
    ...(steamRoot
      ? [join(steamRoot, 'compatibilitytools.d'), join(steamRoot, 'steamapps', 'common')]
      : []),
    compatToolsDir()
  ]
  const builds = new Map<string, ProtonBuild>()
  for (const dir of dirs) {
    let names: string[] = []
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /proton/i.test(e.name))
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const name of names) {
      const bin = join(dir, name, 'proton')
      if (existsSync(bin) && !builds.has(name)) builds.set(name, { name, bin })
    }
  }
  return [...builds.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function gameConfigPath(det: HeroicDetection, appId: string): string | null {
  return det.configDir ? join(det.configDir, 'GamesConfig', `${appId}.json`) : null
}

/** The Proton build forced for this game in Heroic's per-game config, or null when it
 *  uses Heroic's default (the same file resolveWineForGame reads first). */
export function getGameProton(det: HeroicDetection, appId: string): string | null {
  const file = gameConfigPath(det, appId)
  const entry = file ? readJsonSafe<HeroicGameConfigFile>(file)?.[appId] : undefined
  return entry?.wineVersion?.type === 'proton' ? (entry.wineVersion.name ?? null) : null
}

/**
 * Forces a Proton build for a GOG/Epic/Amazon game, or (build null) goes back to the
 * default. Written to Heroic's own per-game config - merged, keeping every other setting
 * there - so Heroic and OmniLauncher agree on what the game runs with. The prefix stays the
 * game's existing one, or Heroic's usual Prefixes/<title> for a game that had none.
 */
export function setGameProton(
  det: HeroicDetection,
  game: UnifiedGame,
  build: ProtonBuild | null
): void {
  const file = gameConfigPath(det, game.appId)
  if (!file || !det.configDir) throw new Error('Heroic config not found')
  const data = (readJsonSafe<Record<string, unknown>>(file) ?? {}) as Record<string, unknown>
  const entry = { ...((data[game.appId] as Record<string, unknown>) ?? {}) }
  if (!build) {
    delete entry.wineVersion
  } else {
    const global = readJsonSafe<HeroicGlobalConfig>(join(det.configDir, 'config.json'))
    const prefixRoot = global?.defaultSettings?.defaultWinePrefix
    entry.wineVersion = { bin: build.bin, name: build.name, type: 'proton' }
    if (!entry.winePrefix && prefixRoot) {
      entry.winePrefix = join(prefixRoot, sanitizeFolderName(game.title))
    }
  }
  data[game.appId] = entry
  if (!('version' in data)) data.version = 'v0'
  if (!('explicit' in data)) data.explicit = true
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

// ---------- Launching through Heroic ----------

const HEROIC_FLATPAK_APP = 'com.heroicgameslauncher.hgl'

/** Heroic's runner name for a store, as its heroic://launch links take it. */
export function heroicRunner(store: StoreKind): string | null {
  if (store === 'gog') return 'gog'
  if (store === 'epic') return 'legendary'
  if (store === 'amazon') return 'nile'
  return null
}

/** argv that starts Heroic in the background (tray only, no window) and has it launch a
 *  game - Heroic then runs it exactly as if Play had been pressed there: its Proton, its
 *  prefix, its fixes, its playtime and cloud saves. */
export function heroicLaunchArgv(det: HeroicDetection, game: UnifiedGame): string[] | null {
  const runner = heroicRunner(game.store)
  if (!runner || !det.present) return null
  const uri = `heroic://launch?appName=${encodeURIComponent(game.appId)}&runner=${runner}`
  const heroic = det.variant === 'flatpak' ? ['flatpak', 'run', HEROIC_FLATPAK_APP] : ['heroic']
  return [...heroic, '--no-gui', uri]
}

/** The environment variables OmniLauncher adds to a Heroic game for one session. */
const SESSION_ENV_KEYS = [
  'OMNILAUNCHER_GAME_ID',
  'SDL_GAMECONTROLLER_IGNORE_DEVICES',
  'SDL_JOYSTICK_HIDAPI'
]

interface HeroicEnvEntry {
  key: string
  value: string
}

/**
 * Adds `env` to the game's environment in Heroic's per-game config (its "Environment
 * Variables" setting), or with null takes OmniLauncher's entries back out - everything else
 * there is left as it was. Heroic reads this file when it first loads the game's config,
 * so it must not be running while this changes (see quitHeroic).
 */
export function setHeroicSessionEnv(
  det: HeroicDetection,
  appId: string,
  env: Record<string, string> | null
): void {
  const file = gameConfigPath(det, appId)
  if (!file) return
  const data = (readJsonSafe<Record<string, unknown>>(file) ?? {}) as Record<string, unknown>
  const entry = { ...((data[appId] as Record<string, unknown>) ?? {}) }
  const kept = ((entry.enviromentOptions as HeroicEnvEntry[] | undefined) ?? []).filter(
    (e) => !SESSION_ENV_KEYS.includes(e.key)
  )
  const added = env ? Object.entries(env).map(([key, value]) => ({ key, value })) : []
  if (!env && kept.length === ((entry.enviromentOptions as unknown[]) ?? []).length) return
  if (kept.length || added.length) entry.enviromentOptions = [...kept, ...added]
  else delete entry.enviromentOptions
  data[appId] = entry
  if (!('version' in data)) data.version = 'v0'
  if (!('explicit' in data)) data.explicit = true
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

/** Takes session entries back out of every game's config - for a session OmniLauncher
 *  didn't get to finish (it was closed or crashed while a game ran). */
export function clearAllHeroicSessionEnv(det: HeroicDetection): void {
  if (!det.configDir) return
  let names: string[] = []
  try {
    names = readdirSync(join(det.configDir, 'GamesConfig'))
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'default.json') continue
    try {
      setHeroicSessionEnv(det, name.slice(0, -5), null)
    } catch {
      // unreadable config - leave it alone
    }
  }
}

/** Pids of Heroic's main (browser) process - not its renderer/GPU/zygote helpers. */
async function heroicMainPids(): Promise<number[]> {
  const { stdout } = await execFileP('ps', ['-eo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 })
  const pids: number[] = []
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    const args = m[2]
    if (/(^|\/)heroic\/heroic(\s|$)/.test(args) && !args.includes('--type=')) {
      pids.push(Number(m[1]))
    }
  }
  return pids
}

export async function isHeroicRunning(): Promise<boolean> {
  try {
    return (await heroicMainPids()).length > 0
  } catch {
    return false
  }
}

/** Asks Heroic to quit (SIGTERM - Electron treats it as a normal quit, so Heroic saves
 *  its state) and waits for it to be gone. */
export async function quitHeroic(timeoutMs = 15000): Promise<void> {
  let pids: number[]
  try {
    pids = await heroicMainPids()
  } catch {
    return
  }
  if (!pids.length) return
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    if (!(await isHeroicRunning())) return
  }
}
