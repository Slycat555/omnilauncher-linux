import { execSync, spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { UnifiedGame } from '../../shared/types'
import { isVdfObject, parseVdf, type VdfNode } from '../vdf'
import type { SteamDetection } from './detect'

function str(v: VdfNode | string | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: VdfNode | string | undefined, fallback = 0): number {
  const s = str(v, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

/** Best-effort default for the Web API SteamID64 field: the account currently logged
 *  into the GUI client, whose SteamID64 is the top-level key of its own entry in
 *  loginusers.vdf - the same file/shape used elsewhere to read the account name. Falls
 *  back to letting the user paste it in Settings if this can't be read. */
export function readDefaultSteamId64(steamRoot: string): string | null {
  const vdfPath = join(steamRoot, 'config', 'loginusers.vdf')
  if (!existsSync(vdfPath)) return null
  try {
    const parsed = parseVdf(readFileSync(vdfPath, 'utf-8'))
    const users = parsed['users']
    if (!isVdfObject(users)) return null
    const ids = Object.keys(users)
    return ids.length > 0 ? ids[0] : null
  } catch {
    return null
  }
}

function readLibraryFolders(steamRoot: string): string[] {
  const vdfPath = join(steamRoot, 'steamapps', 'libraryfolders.vdf')
  if (!existsSync(vdfPath)) return [steamRoot]
  try {
    const parsed = parseVdf(readFileSync(vdfPath, 'utf-8'))
    const root = parsed['libraryfolders']
    if (!isVdfObject(root)) return [steamRoot]
    const paths: string[] = []
    for (const key of Object.keys(root)) {
      const entry = root[key]
      if (isVdfObject(entry) && typeof entry['path'] === 'string') {
        paths.push(entry['path'] as string)
      }
    }
    return paths.length > 0 ? paths : [steamRoot]
  } catch {
    return [steamRoot]
  }
}

function readPlaytimes(steamRoot: string): Map<string, { minutes: number; lastPlayed: number }> {
  const result = new Map<string, { minutes: number; lastPlayed: number }>()
  const userdataDir = join(steamRoot, 'userdata')
  if (!existsSync(userdataDir)) return result
  for (const accountId of readdirSync(userdataDir)) {
    const localConfig = join(userdataDir, accountId, 'config', 'localconfig.vdf')
    if (!existsSync(localConfig)) continue
    try {
      const parsed = parseVdf(readFileSync(localConfig, 'utf-8'))
      const apps = navigate(parsed, [
        'UserLocalConfigStore',
        'Software',
        'Valve',
        'Steam',
        'apps'
      ])
      if (!isVdfObject(apps)) continue
      for (const appId of Object.keys(apps)) {
        const appNode = apps[appId]
        if (!isVdfObject(appNode)) continue
        result.set(appId, {
          minutes: num(appNode['Playtime']),
          lastPlayed: num(appNode['LastPlayed'])
        })
      }
    } catch {
      // ignore malformed/missing localconfig for this account
    }
  }
  return result
}

function navigate(node: VdfNode, path: string[]): VdfNode | string | undefined {
  let current: VdfNode | string | undefined = node
  for (const key of path) {
    if (!isVdfObject(current)) return undefined
    current = current[key]
  }
  return current
}

/**
 * Steam installs these as regular appmanifest_*.acf entries just like real games (Proton
 * Experimental, Steam Linux Runtime 1.0 (scout)/3.0 (sniper)/4.0, Steamworks Common
 * Redistributables, ...), so they show up in a naive scan indistinguishable from a game.
 * There is no local metadata flagging them as a "tool" (that lives in the binary
 * appinfo.vdf we don't parse), so match by name instead. Anchored to the start of the
 * name to avoid filtering a real game that merely mentions one of these words.
 */
const STEAM_NON_GAME_RE = /^(proton\b|steam linux runtime\b|steamworks common redistributables$)/i

function isSteamNonGame(name: string): boolean {
  return STEAM_NON_GAME_RE.test(name)
}

interface OwnedGame {
  appid: number
  name: string
  playtime_forever?: number
  rtime_last_played?: number
  img_icon_url?: string
}

/**
 * There is no local file listing everything a Steam account owns (only what is
 * installed) - the Web API is the only source for owned-but-not-installed games.
 */
export async function fetchOwnedSteamGames(
  apiKey: string,
  steamId64: string
): Promise<UnifiedGame[]> {
  if (!apiKey || !steamId64) return []
  const url =
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` +
    `?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId64)}` +
    `&include_appinfo=1&include_played_free_games=1&format=json`
  let games: OwnedGame[]
  try {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(
        res.status === 401 || res.status === 403
          ? 'Steam Web API key was rejected (401/403). Check the key in Settings.'
          : `Steam Web API returned HTTP ${res.status}`
      )
    }
    const json = (await res.json()) as { response?: { games?: OwnedGame[] } }
    games = json.response?.games ?? []
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Steam Web API')) throw err
    throw new Error(
      'Could not reach the Steam Web API. Check your network connection and the SteamID64.'
    )
  }
  if (games.length === 0) {
    // A key+id that resolve to zero games almost always means the profile's game
    // details are private (the Web API silently returns an empty list, not an error).
    throw new Error(
      'Steam returned 0 owned games. Make sure "Game details" is set to Public in your Steam privacy settings (steamcommunity.com/my/edit/settings).'
    )
  }
  return games
    .filter((g) => !isSteamNonGame(g.name))
    .map((g) => {
      const appId = String(g.appid)
      return {
        id: `steam:${appId}`,
        store: 'steam',
        appId,
        title: g.name,
        isInstalled: false,
        isInstalling: false,
        platform: 'windows',
        playtimeMinutes: g.playtime_forever,
        lastPlayed: g.rtime_last_played,
        canLaunch: false,
        canInstall: true,
        canUninstall: false
      }
    })
}

export interface SteamLibraryResult {
  games: UnifiedGame[]
  /** Non-fatal: e.g. Web API key rejected. Local installed-game scan still ran. */
  warning?: string
}

export async function readSteamLibrary(
  det: SteamDetection,
  webApi?: { apiKey: string; steamId64: string }
): Promise<SteamLibraryResult> {
  if (!det.present || !det.root) return { games: [] }
  const libraryPaths = readLibraryFolders(det.root)
  const playtimes = readPlaytimes(det.root)
  const games = new Map<string, UnifiedGame>()
  let warning: string | undefined

  const steamId64 = webApi?.steamId64?.trim() || readDefaultSteamId64(det.root) || ''
  if (webApi?.apiKey && steamId64) {
    // Owned-but-not-installed games go in first; the local installed-app scan below
    // overwrites entries for anything actually on disk with the more accurate data.
    // A failure here (bad key, private profile, network) must not take down the local
    // installed-game scan below - only the Web API portion is best-effort.
    try {
      for (const g of await fetchOwnedSteamGames(webApi.apiKey, steamId64)) {
        games.set(g.appId, g)
      }
    } catch (err) {
      warning = err instanceof Error ? err.message : String(err)
    }
  }

  for (const libPath of libraryPaths) {
    const steamappsDir = join(libPath, 'steamapps')
    if (!existsSync(steamappsDir)) continue
    let files: string[]
    try {
      files = readdirSync(steamappsDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.startsWith('appmanifest_') || !file.endsWith('.acf')) continue
      const appId = file.slice('appmanifest_'.length, -'.acf'.length)
      try {
        const parsed = parseVdf(readFileSync(join(steamappsDir, file), 'utf-8'))
        const state = parsed['AppState']
        if (!isVdfObject(state)) continue
        const name = str(state['name'])
        if (!name || isSteamNonGame(name)) continue
        const stateFlags = num(state['StateFlags'])
        const fullyInstalled = (stateFlags & 4) !== 0
        const pt = playtimes.get(appId)
        games.set(appId, {
          id: `steam:${appId}`,
          store: 'steam',
          appId,
          title: name,
          isInstalled: fullyInstalled,
          isInstalling: false,
          installPath: join(steamappsDir, 'common', str(state['installdir'])),
          sizeOnDisk: num(state['SizeOnDisk']),
          platform: 'windows',
          playtimeMinutes: pt?.minutes,
          lastPlayed: pt?.lastPlayed,
          canLaunch: fullyInstalled,
          canInstall: !fullyInstalled,
          canUninstall: fullyInstalled
        })
      } catch {
        // skip unreadable manifest
      }
    }
  }

  return { games: Array.from(games.values()), warning }
}

/** ~/.steam/steam.pid is only ever a hint - Steam does not clean it up on exit, so a
 *  liveness check on the PID it names is required, not just the file's existence. */
function isSteamRunning(): boolean {
  try {
    const pidFile = join(homedir(), '.steam', 'steam.pid')
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
    if (!Number.isFinite(pid)) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Steam launches every game (native or Proton) under its "reaper" process, tagged
 *  with the appid on the command line - so this is the one reliable signal that a
 *  Steam-launched game is still actually running, since Steam itself is a detached
 *  process we have no other handle on. */
export function isSteamGameRunning(appId: string): boolean {
  try {
    execSync(`pgrep -f "reaper SteamLaunch AppId=${appId} "`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface SteamInstallState {
  /** Bit 4 = fully installed. Bit 8/16/64 etc cover downloading/staging/committing -
   *  not decoded individually since bytesDownloaded/bytesToDownload already give a
   *  cleaner percentage, this is only used to tell "idle" apart from "doing something". */
  stateFlags: number
  fullyInstalled: boolean
  bytesDownloaded: number
  bytesToDownload: number
}

/** Reads the same appmanifest_<id>.acf Steam itself writes live during an install, so
 *  progress can be observed without any process of our own to read output from - Steam
 *  updates this file continuously (every ~1s) for the whole duration of a download. */
export function readSteamInstallState(steamRoot: string, appId: string): SteamInstallState | null {
  for (const libPath of readLibraryFolders(steamRoot)) {
    const manifestPath = join(libPath, 'steamapps', `appmanifest_${appId}.acf`)
    if (!existsSync(manifestPath)) continue
    try {
      const parsed = parseVdf(readFileSync(manifestPath, 'utf-8'))
      const state = parsed['AppState']
      if (!isVdfObject(state)) continue
      const stateFlags = num(state['StateFlags'])
      return {
        stateFlags,
        fullyInstalled: (stateFlags & 4) !== 0,
        bytesDownloaded: num(state['BytesDownloaded']),
        bytesToDownload: num(state['BytesToDownload'])
      }
    } catch {
      continue
    }
  }
  return null
}

/** Closes every window whose `wmctrl -l -x` line matches `pred` - shared by
 *  closeSteamWindow() and closeVulkanShaderWindow(), which only differ in what they
 *  match on (WM_CLASS vs window title), not in how closing actually happens. */
function closeMatchingWindows(pred: (line: string) => boolean): void {
  try {
    execSync('wmctrl -l -x', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter(pred)
      .forEach((line) => {
        const id = line.trim().split(/\s+/)[0]
        if (id) {
          try {
            execSync(`wmctrl -ic ${id}`, { stdio: 'ignore' })
          } catch {
            // window may have already closed on its own
          }
        }
      })
  } catch {
    // wmctrl not available or nothing to close - not fatal, the window just stays up
  }
}

/** Closes the Steam client's own window(s) - used once an install/uninstall we
 *  dispatched has visibly started, so the confirmation dialog the user had to click
 *  through doesn't linger on screen for the whole download. Closing the window does not
 *  stop the download: the actual download is driven by the `steam` client process
 *  itself, not the steamwebhelper-owned window, the same way closing Steam "to tray"
 *  during a normal download never interrupts it. */
export function closeSteamWindow(): void {
  closeMatchingWindows((line) => line.includes('steamwebhelper.steam'))
}

/**
 * Closes Steam's "Vulkan Shader Cache - Processing shaders" dialog that appears before
 * a game's own window when a Proton title needs to pre-compile shaders (can take
 * anywhere from seconds to several minutes on a first run or after a driver update).
 * This dialog reuses the game's own WM_CLASS (steam_app_<appid>), not Steam's - so
 * unlike closeSteamWindow() it cannot be matched by class alone without risking closing
 * the actual game window once shaders are done and it takes over. Steam hardcodes the
 * literal string "Vulkan Shader Cache" in this dialog's title across versions/distros,
 * so matching on that is the safe, specific signal - a real game's own window title is
 * never going to contain it.
 */
export function closeVulkanShaderWindow(): void {
  closeMatchingWindows((line) => line.includes('Vulkan Shader Cache'))
}

function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

function steamUri(execCommand: string[], uri: string): void {
  const [cmd, ...args] = execCommand

  if (!isSteamRunning()) {
    // Cold start: bring Steam up minimized to the tray (no main window ever appears)
    // before handing it the action, instead of letting Steam's own default startup
    // flash its full GUI open first. A URI sent to a not-yet-initialized client can
    // also race its startup, so give it a moment before forwarding the actual command.
    spawnDetached(cmd, [...args, '-silent'])
    setTimeout(() => spawnDetached(cmd, [...args, uri, '-silent']), 4000)
    return
  }

  // Steam is already running - forward the action to that instance. '-silent' MUST come
  // AFTER the URI here: Steam only honours it in that order for a running instance (the
  // reverse order suppresses the window but silently drops the action - the game never
  // launches). Verified empirically; this isn't documented anywhere by Valve.
  //
  // Note: this still lets a brief "Launching..." dialog flash for a couple of seconds -
  // that dialog is not gated by -silent (or any other client flag) at all, only the main
  // library window is. The only way to remove it entirely is to skip the Steam client for
  // launches and run the game's Proton/native command directly ourselves, which was
  // deliberately not done: it would need per-game Proton prefix/compat-data plumbing and
  // loses the overlay, for a two-second cosmetic flash. Revisit only if asked again.
  spawnDetached(cmd, [...args, uri, '-silent'])
}

/**
 * Install/uninstall need the confirmation dialog Steam shows before it does anything,
 * so unlike steamUri() this deliberately never passes -silent: doing so does not just
 * hide the main window here like it does for a launch - it makes Steam auto-dismiss the
 * whole confirmation dialog within ~2-3s with nothing confirmed and no download ever
 * starting, silently no-op'ing the install. Verified by direct comparison: with
 * -silent the "Install" window closes itself in 2-3s; without it, it stays open and
 * waits for a real click, exactly like running steam://install/<id> from a terminal by
 * hand always has. The window this opens is closed automatically instead, once
 * closeSteamWindow() confirms (via the on-disk manifest) that the user has actually
 * clicked through it and a download has begun.
 */
function steamUriForInstall(execCommand: string[], uri: string): void {
  const [cmd, ...args] = execCommand
  if (!isSteamRunning()) {
    spawnDetached(cmd, [...args, '-silent'])
    setTimeout(() => spawnDetached(cmd, [...args, uri]), 4000)
    return
  }
  spawnDetached(cmd, [...args, uri])
}

export function launchSteamGame(det: SteamDetection, appId: string): void {
  if (!det.execCommand) return
  steamUri(det.execCommand, `steam://rungameid/${appId}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface SteamInstallProgress {
  percent?: number
  bytesDone?: number
  bytesTotal?: number
}

/**
 * Handled by the Steam client itself (its own download UI - the one part of this that
 * cannot be made silent, since Steam requires an explicit Install/Cancel click in its
 * own window before any download starts, no flag or URI trick suppresses that dialog).
 * Once the user clicks through it and a download genuinely begins, this closes Steam's
 * window (the download itself keeps running - see closeSteamWindow) and polls the same
 * on-disk manifest Steam itself writes to report real progress, resolving only once the
 * install has actually finished.
 */
export async function installSteamGame(
  det: SteamDetection,
  appId: string,
  onProgress?: (p: SteamInstallProgress) => void
): Promise<void> {
  if (!det.execCommand || !det.root) throw new Error('Steam not found')
  steamUriForInstall(det.execCommand, `steam://install/${appId}`)

  // Deliberately no fixed delay before polling starts: the dialog now stays open on its
  // own (see steamUriForInstall) until the user actually clicks Install, however long
  // that takes - polling just waits for the manifest to appear, which only happens once
  // they do, and closeSteamWindow() only runs from that point on.
  let windowClosed = false
  const deadline = Date.now() + 30 * 60 * 1000 // long enough for a large game on a slow link
  while (Date.now() < deadline) {
    const state = readSteamInstallState(det.root, appId)
    if (state) {
      if (!windowClosed) {
        closeSteamWindow()
        windowClosed = true
      }
      if (state.fullyInstalled) return
      if (state.bytesToDownload > 0) {
        onProgress?.({
          percent: (state.bytesDownloaded / state.bytesToDownload) * 100,
          bytesDone: state.bytesDownloaded,
          bytesTotal: state.bytesToDownload
        })
      }
    }
    await sleep(1500)
  }
  throw new Error('Install timed out - check the Steam client.')
}

export async function uninstallSteamGame(det: SteamDetection, appId: string): Promise<void> {
  if (!det.execCommand || !det.root) throw new Error('Steam not found')
  // Confirmed separately from install: the Uninstall dialog does NOT auto-dismiss
  // itself under -silent the way Install does, so the ordinary steamUri() path (which
  // keeps the main library window backgrounded) is safe here without needing the
  // no-silent workaround.
  //
  // Unlike install, this deliberately does NOT auto-close the confirmation window: the
  // manifest for an app being uninstalled already exists from BEFORE the user clicks
  // anything (it's the currently-installed game's own manifest), so its mere presence
  // can't distinguish "waiting for a click" from "click already happened" the way a
  // fresh install's manifest appearing from nothing can. Closing on a guessed delay was
  // the same premature-close bug install had; there's no safe on-disk signal to poll
  // for here instead, so the window is left for the user to dismiss themselves and this
  // only polls for the real completion signal (the manifest disappearing).
  steamUri(det.execCommand, `steam://uninstall/${appId}`)

  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    if (!readSteamInstallState(det.root, appId)) return
    await sleep(1000)
  }
  throw new Error('Uninstall timed out - check the Steam client.')
}
