import { execSync, spawn } from 'child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { UnifiedGame } from '../../shared/types'
import { isVdfObject, parseVdf, type VdfNode } from '../vdf'
import { STEAM_FLATPAK_ID, type SteamDetection } from './detect'
import { steamAutoInstall, steamUninstall, waitForSteamCef } from './steamCef'
import { hostEnv } from '../hostEnv'

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

export function readLibraryFolders(steamRoot: string): string[] {
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
      const apps = navigate(parsed, ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'])
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
 *  liveness check on the PID it names is required, not just the file's existence.
 *
 *  This always checked the *native* path even for a flatpak install, whose sandboxed
 *  $HOME redirects that same relative file under ~/.var/app/<id>/ instead (confirmed
 *  against how this app's own detectSteam() already computes the flatpak install's
 *  .local/share/Steam path the same way) - so isSteamRunning() unconditionally reported
 *  "not running" for flatpak Steam even while it very much was, which meant every single
 *  launch/install/uninstall action always took the cold-start branch below: it would
 *  spawn a redundant second Steam invocation and then sit through an unnecessary extra
 *  ~4s delay before forwarding the real action, every single time, whether or not Steam
 *  needed starting at all. */
export function isSteamRunning(variant: SteamDetection['variant']): boolean {
  try {
    const steamHome =
      variant === 'flatpak' ? join(homedir(), '.var', 'app', STEAM_FLATPAK_ID) : homedir()
    const pidFile = join(steamHome, '.steam', 'steam.pid')
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
 *  process we have no other handle on.
 *
 *  Matching the exact literal "reaper SteamLaunch AppId=<id> " (with a required
 *  trailing space) was too brittle: distro-specific Steam wrappers (confirmed present
 *  here - Bazzite wraps the client in its own launcher script) and different Steam
 *  client versions/beta channels can order or space these tokens differently, or wrap
 *  reaper in extra args. A false negative here doesn't just mis-report launch state -
 *  it's what the app uses to decide whether to keep backgrounding the Steam window and
 *  whether to disable gamepad navigation while a game is on screen, so an unreliable
 *  match here directly caused both "sometimes it doesn't work" symptoms. Matching just
 *  "AppId=<id>" as its own word is far more tolerant of surrounding format differences
 *  while still being specific to this exact game's own reaper invocation. */
export function isSteamGameRunning(appId: string): boolean {
  try {
    execSync(`pgrep -f "\\bAppId=${appId}\\b"`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface SteamInstallState {
  /** Bit 4 ("FullyInstalled") is NOT a reliable "download is done right now" signal on
   *  its own - confirmed directly with a synthetic manifest matching what Steam writes
   *  mid-update: StateFlags can be 6 (bit 4 FullyInstalled | bit 2 UpdateRequired) while
   *  actively downloading an update to an already-installed game, meaning the old
   *  `(stateFlags & 4) !== 0` check reported the game as finished the instant the
   *  manifest existed, before any bytes had actually downloaded - which is what made
   *  progress look undetected (it jumped straight to "installed" or never updated at
   *  all). fullyInstalled below is now bit 4 AND no bytes still pending, not bit 4
   *  alone. */
  stateFlags: number
  fullyInstalled: boolean
  bytesDownloaded: number
  bytesToDownload: number
  /** Uncompressed bytes Steam writes to disk for this update (the "stage" figures). */
  bytesStaged: number
  bytesToStage: number
  /** The Steam library folder holding this app - its steamapps/downloading/<id> is where
   *  the files land while downloading. */
  libPath: string
}

/** Reads appmanifest_<id>.acf for an install's totals and state. NOTE: Steam does NOT
 *  rewrite this file continuously - measured on a live download, BytesDownloaded stayed
 *  frozen for over a minute while gigabytes landed on disk - so its byte counts are only
 *  a coarse checkpoint. measureSteamDownloadBytes() below is the live signal. */
export function readSteamInstallState(steamRoot: string, appId: string): SteamInstallState | null {
  for (const libPath of readLibraryFolders(steamRoot)) {
    const manifestPath = join(libPath, 'steamapps', `appmanifest_${appId}.acf`)
    if (!existsSync(manifestPath)) continue
    try {
      const parsed = parseVdf(readFileSync(manifestPath, 'utf-8'))
      const state = parsed['AppState']
      if (!isVdfObject(state)) continue
      const stateFlags = num(state['StateFlags'])
      const bytesDownloaded = num(state['BytesDownloaded'])
      const bytesToDownload = num(state['BytesToDownload'])
      // A real, in-progress download always has bytesToDownload > 0 with bytes still
      // remaining - trust that directly over trying to fully decode Valve's
      // under-documented StateFlags bitfield, which bit 4 alone was proven insufficient
      // for above.
      const stillDownloading = bytesToDownload > 0 && bytesDownloaded < bytesToDownload
      return {
        stateFlags,
        fullyInstalled: (stateFlags & 4) !== 0 && !stillDownloading,
        bytesDownloaded,
        bytesToDownload,
        bytesStaged: num(state['BytesStaged']),
        bytesToStage: num(state['BytesToStage']),
        libPath
      }
    } catch {
      continue
    }
  }
  return null
}

/** Minimizes every window whose `wmctrl -l -x` line matches `pred`, instead of closing
 *  it - shared by closeSteamWindow() and closeVulkanShaderWindow(), which only differ
 *  in what they match on (WM_CLASS vs window title), not in how hiding actually
 *  happens.
 *
 *  Switched from actually closing (wmctrl -ic) to minimizing for two reasons: closing
 *  can only ever react to a window that has already rendered and become visible -
 *  there's an unavoidable flash between the dialog appearing and our poll catching it,
 *  no matter how tight the interval. Minimizing has the exact same "can't act before it
 *  exists" limitation, but leaves the window and its underlying process/state fully
 *  intact rather than destroying it, which matters more for the shader-cache dialog
 *  specifically (closing a window Steam still expects to be managing partway through
 *  shader compilation is a real, if narrow, risk that minimizing it entirely avoids).
 *
 *  Uses `xdotool windowminimize`, not `wmctrl -b add,hidden` - confirmed directly by
 *  spawning a real test window that the EWMH client-message approach (`wmctrl -r <id>
 *  -b add,hidden`) is silently a no-op on this compositor (window stayed fully visible,
 *  _NET_WM_STATE never gained _HIDDEN), while xdotool's minimize actually works
 *  (confirmed via WM_STATE reading "Iconic" afterward). */
/** Windows already minimized - minimizing again every poll made KWin process a state
 *  change each time for no reason. */
const minimizedWindows = new Set<string>()

function hideMatchingWindows(pred: (line: string) => boolean): void {
  try {
    execSync('wmctrl -l -x', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter(pred)
      .forEach((line) => {
        const id = line.trim().split(/\s+/)[0]
        if (id && !minimizedWindows.has(id)) {
          minimizedWindows.add(id)
          try {
            execSync(`xdotool windowminimize ${id}`, { stdio: 'ignore' })
          } catch {
            // window may have already closed on its own
          }
        }
      })
  } catch {
    // wmctrl not available or nothing to hide - not fatal, the window just stays up
  }
}

/** Minimizes the Steam client's own window(s) - used once an install/uninstall we
 *  dispatched has visibly started, so the confirmation dialog the user had to click
 *  through doesn't linger on screen for the whole download. Minimizing the window does
 *  not stop the download: the actual download is driven by the `steam` client process
 *  itself, not the steamwebhelper-owned window, the same way minimizing Steam "to tray"
 *  during a normal download never interrupts it.
 *
 *  Matches on the substring "steamwebhelper" alone, not the previously-hardcoded
 *  "steamwebhelper.steam" - the flatpak build's window reports a differently-cased/
 *  suffixed WM_CLASS (its desktop/app id is "com.valvesoftware.Steam", not "steam"),
 *  which made this predicate match nothing at all and left every dialog sitting on
 *  screen for flatpak Steam even though the native package's window matched fine. */
export function closeSteamWindow(): void {
  hideMatchingWindows((line) => line.includes('steamwebhelper'))
}

/**
 * Minimizes Steam's "Vulkan Shader Cache - Processing shaders" dialog that appears
 * before a game's own window when a Proton title needs to pre-compile shaders (can take
 * anywhere from seconds to several minutes on a first run or after a driver update).
 * This dialog reuses the game's own WM_CLASS (steam_app_<appid>), not Steam's - so
 * unlike closeSteamWindow() it cannot be matched by class alone without risking hiding
 * the actual game window once shaders are done and it takes over. Steam hardcodes the
 * literal string "Vulkan Shader Cache" in this dialog's title across versions/distros,
 * so matching on that is the safe, specific signal - a real game's own window title is
 * never going to contain it.
 */
export function closeVulkanShaderWindow(): void {
  hideMatchingWindows((line) => line.includes('Vulkan Shader Cache'))
}

/**
 * Event-driven alternative to polling closeSteamWindow()/closeVulkanShaderWindow() on
 * an interval. Polling can only ever react after a dialog has already rendered and
 * become visible for however long the interval takes to notice it - tightening the
 * interval reduces but can't eliminate that flash. This instead runs a single
 * long-lived `xprop -root -spy _NET_CLIENT_LIST` process that the X server itself
 * pushes an updated line to the instant any top-level window is mapped or unmapped
 * (verified: `xprop -root _NET_CLIENT_LIST` returns the live list immediately, and
 * -spy is the documented "watch this property forever" mode) - so a new window is seen
 * and can be acted on within milliseconds of actually existing, not up to a poll
 * interval later. X11/XWayland only, same as wmctrl - silently does nothing under
 * native Wayland (checked once at startup, not per call).
 *
 * Only started once for the whole app lifetime (spawning a new `xprop -spy` per launch
 * would itself add startup latency defeating the purpose) and gated by
 * `suppressionArmed` so it only actually hides windows during an active Steam launch,
 * not any time the user has Steam's own window open for a legitimate reason.
 */
let watcherStarted = false
let suppressionArmed = false
let knownWindowIds = new Set<string>()

/** xprop's _NET_CLIENT_LIST reports window ids as bare hex ("0x3a00024"), but wmctrl -l
 *  zero-pads them to a fixed 8 hex digits ("0x03a00024") - confirmed directly by
 *  spawning a real window and reading both. Grepping the raw xprop id against wmctrl's
 *  output silently never matched anything because of this, even for a genuinely present
 *  window - this normalizes both to the same numeric value before comparing instead of
 *  string-matching a format that isn't actually consistent between the two tools. */
function normalizeWindowId(id: string): string {
  return BigInt(id).toString(16)
}

function windowMatchesSuppressTarget(id: string): boolean {
  try {
    const target = normalizeWindowId(id)
    const lines = execSync('wmctrl -l -x', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
    const line = lines.find((l) => {
      const wid = l.trim().split(/\s+/)[0]
      return wid && normalizeWindowId(wid) === target
    })
    if (!line) return false
    return line.includes('steamwebhelper') || line.includes('Vulkan Shader Cache')
  } catch {
    return false
  }
}

export function armSteamWindowSuppression(): void {
  // A new launch: windows the user has since reopened may be minimized again.
  minimizedWindows.clear()
  suppressionArmed = true
  if (watcherStarted) return
  watcherStarted = true

  try {
    const watcher = spawn('xprop', ['-root', '-spy', '_NET_CLIENT_LIST'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    watcher.unref()
    let buf = ''
    watcher.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        // xprop writes "window id #" once, followed by a single comma-separated list
        // of hex ids - not once per id. Matching the "window id #" prefix per-id (as an
        // earlier version of this did) only ever caught the first id in the list and
        // silently missed every window after it, which would have made this whole
        // watcher functionally blind to anything but the very first window it ever saw.
        // Confirmed directly by spawning a real X11 window (xmessage) while watching.
        const afterHash = line.split('window id #')[1]
        const ids = new Set(
          afterHash
            ? afterHash
                .split(',')
                .map((s) => s.trim())
                .filter((s) => /^0x[0-9a-fA-F]+$/.test(s))
            : []
        )
        const newIds = [...ids].filter((id) => !knownWindowIds.has(id))
        knownWindowIds = ids
        if (!suppressionArmed) continue
        for (const id of newIds) {
          if (windowMatchesSuppressTarget(id)) {
            try {
              execSync(`xdotool windowminimize ${id}`, { stdio: 'ignore' })
            } catch {
              // gone already - fine
            }
          }
        }
      }
    })
  } catch {
    // xprop not available (e.g. native Wayland with no XWayland) - the polling-based
    // closeSteamWindow()/closeVulkanShaderWindow() calls elsewhere in the launch flow
    // remain as the fallback, just without this tighter reaction time.
  }
}

export function disarmSteamWindowSuppression(): void {
  suppressionArmed = false
}

function spawnDetached(cmd: string, args: string[]): void {
  // hostEnv: Steam is often started from here, and everything it launches inherits
  // its environment - it must not carry OmniLauncher's AppImage paths.
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: hostEnv() })
  child.unref()
}

/**
 * Builds the actual argv to spawn for execCommand (either ['steam'] or ['flatpak',
 * 'run', <id>]) plus whatever Steam-specific flags/URI are being sent. flatpak's own
 * `run` stops parsing its own options once it reaches the app id, but the recommended,
 * unambiguous way to guarantee everything after that is passed straight through to the
 * sandboxed app rather than risk `flatpak run` itself trying to interpret a
 * dash-prefixed argument (like "-silent") as one of its own options is an explicit `--`
 * separator - see flatpak-run(1). Native `steam` has no such wrapper/parser in front of
 * it and needs nothing extra.
 */
function steamArgv(execCommand: string[], steamArgs: string[]): { cmd: string; args: string[] } {
  const [cmd, ...prefix] = execCommand
  const separator = cmd === 'flatpak' ? ['--'] : []
  return { cmd, args: [...prefix, ...separator, ...steamArgs] }
}

function steamUri(execCommand: string[], variant: SteamDetection['variant'], uri: string): void {
  if (!isSteamRunning(variant)) {
    // Cold start: bring Steam up minimized to the tray (no main window ever appears)
    // before handing it the action, instead of letting Steam's own default startup
    // flash its full GUI open first. A URI sent to a not-yet-initialized client can
    // also race its startup, so give it a moment before forwarding the actual command.
    const cold = steamArgv(execCommand, ['-silent'])
    spawnDetached(cold.cmd, cold.args)
    setTimeout(() => {
      const warm = steamArgv(execCommand, [uri, '-silent'])
      spawnDetached(warm.cmd, warm.args)
    }, 4000)
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
  const running = steamArgv(execCommand, [uri, '-silent'])
  spawnDetached(running.cmd, running.args)
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
function steamUriForInstall(
  execCommand: string[],
  variant: SteamDetection['variant'],
  uri: string
): void {
  if (!isSteamRunning(variant)) {
    const cold = steamArgv(execCommand, ['-silent'])
    spawnDetached(cold.cmd, cold.args)
    setTimeout(() => {
      const warm = steamArgv(execCommand, [uri])
      spawnDetached(warm.cmd, warm.args)
    }, 4000)
    return
  }
  const running = steamArgv(execCommand, [uri])
  spawnDetached(running.cmd, running.args)
}

/** Starts Steam with no window at all (-silent: tray only) if it isn't already running.
 *  Called at OmniLauncher startup too, so Steam is warm - and its install API reachable -
 *  by the time anything is installed or launched, without its library window appearing. */
export function startSteamSilently(det: SteamDetection): boolean {
  if (!det.execCommand || isSteamRunning(det.variant)) return false
  const cold = steamArgv(det.execCommand, ['-silent'])
  spawnDetached(cold.cmd, cold.args)
  return true
}

/** Asks Steam to quit and waits (up to `timeoutMs`) for it to be gone. A GOG game runs
 *  with OmniLauncher's own controller layer instead of Steam Input, and a running Steam
 *  would otherwise grab the same controllers (and its virtual pads) out from under it. */
export async function shutdownSteam(det: SteamDetection, timeoutMs = 20000): Promise<boolean> {
  if (!det.execCommand || !isSteamRunning(det.variant)) return false
  const quit = steamArgv(det.execCommand, ['-shutdown'])
  spawnDetached(quit.cmd, quit.args)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(500)
    if (!isSteamRunning(det.variant)) return true
  }
  return !isSteamRunning(det.variant)
}

export function launchSteamGame(det: SteamDetection, appId: string): void {
  if (!det.execCommand) return
  steamUri(det.execCommand, det.variant, `steam://rungameid/${appId}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Bytes actually written so far in steamapps/downloading/<appId>. Steam writes each
 *  file there as it's downloaded and decompressed (it does not preallocate them - its
 *  content log shows "preallocated 0 files"), so allocated disk blocks track real staging
 *  progress live, unlike the manifest. Counted via st_blocks rather than st_size so a
 *  sparse or pre-sized file can't overstate progress. */
export function measureSteamDownloadBytes(libPath: string, appId: string): number {
  let total = 0
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      try {
        const st = lstatSync(path)
        if (st.isDirectory()) walk(path)
        else if (st.isFile()) total += st.blocks * 512
      } catch {
        // file moved/removed mid-walk (Steam commits files out of here) - skip it
      }
    }
  }
  walk(join(libPath, 'steamapps', 'downloading', appId))
  return total
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
/** Ids of Steam's own top-level windows right now (main window, dialogs) - used to tell
 *  when the install dialog has appeared and when it's been closed again. */
function steamWindowIds(): Set<string> {
  try {
    return new Set(
      execSync('wmctrl -l -x', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .split('\n')
        .filter((line) => line.includes('steamwebhelper'))
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean)
    )
  } catch {
    return new Set()
  }
}

export type SteamInstallOutcome = 'installed' | 'cancelled'

export async function installSteamGame(
  det: SteamDetection,
  appId: string,
  onProgress?: (p: SteamInstallProgress) => void,
  /** Set once the user cancels in OmniLauncher (InstallManager.cancel has already told
   *  Steam to stop) - ends the wait instead of polling a download that's going away. */
  isCancelled: () => boolean = () => false
): Promise<SteamInstallOutcome> {
  if (!det.execCommand || !det.root) throw new Error('Steam not found')

  // Windows that already existed (Steam's main window) - anything new after this is the
  // install dialog, whose disappearance without a download means the user cancelled.
  const baselineWindows = steamWindowIds()

  // Preferred path: confirm Steam's install wizard through its own API (steamCef.ts), so
  // no dialog needs clicking. Falls back to the normal steam://install dialog when
  // Steam's remote debugging isn't enabled, or when Steam genuinely needs the user
  // (EULA, not enough disk space) - in that case its dialog is already open.
  // Steam not running: start it silently and wait for its install API, rather than going
  // through steam://install, whose dialog is exactly what this path avoids.
  if (startSteamSilently(det)) await waitForSteamCef(120000)
  // Steam's desktop UI still opens its own install window alongside the wizard even
  // though every question is answered through the API - minimize it the instant it maps
  // so Steam stays headless. Disarmed afterwards so the user can still open Steam.
  armSteamWindowSuppression()
  let auto: Awaited<ReturnType<typeof steamAutoInstall>>
  try {
    auto = await steamAutoInstall(appId)
  } finally {
    disarmSteamWindowSuppression()
  }
  if (auto.result === 'cancelled') return 'cancelled'
  if (auto.result === 'failed') throw new Error(auto.reason)
  if (auto.result === 'unavailable') {
    steamUriForInstall(det.execCommand, det.variant, `steam://install/${appId}`)
  }
  const watchDialog = auto.result !== 'started'

  let windowClosed = false
  let manifestSeen = false
  let dialogSeen = false
  let dialogGoneAt = 0
  // Progress never moves backwards: when the download finishes Steam moves the files out
  // of steamapps/downloading into the game folder, so the live on-disk measure shrinks
  // right before the manifest finally reports the install as complete.
  let bestFraction = 0
  // Only the wait for the install to *start* is bounded - a large game on a slow link
  // can download for hours, and must not be reported as failed partway through.
  const startDeadline = Date.now() + 30 * 60 * 1000

  for (;;) {
    if (isCancelled()) return 'cancelled'
    const state = readSteamInstallState(det.root, appId)

    if (!state) {
      // The manifest existing and then vanishing is how Steam cancels a fresh install
      // (removing it from the Downloads list / "Uninstall" mid-download).
      if (manifestSeen) return 'cancelled'

      if (watchDialog) {
        const newWindows = [...steamWindowIds()].filter((id) => !baselineWindows.has(id))
        if (newWindows.length > 0) {
          dialogSeen = true
          dialogGoneAt = 0
        } else if (dialogSeen) {
          // Closed without a manifest appearing: the user hit Cancel. A short grace
          // period covers the gap between clicking Install and Steam writing the file.
          if (!dialogGoneAt) dialogGoneAt = Date.now()
          else if (Date.now() - dialogGoneAt > 4000) return 'cancelled'
        }
      }
      if (Date.now() > startDeadline) throw new Error('Install timed out - check the Steam client.')
      await sleep(1500)
      continue
    }

    manifestSeen = true
    if (!windowClosed) {
      closeSteamWindow()
      windowClosed = true
    }
    if (state.fullyInstalled) return 'installed'
    if (state.bytesToDownload > 0) {
      // The manifest's own figure is a stale checkpoint; the bytes on disk relative to
      // the uncompressed total are live. Both are fractions of the same update, so the
      // larger one is the most recent truth. Reported in download (network) bytes, the
      // same units Steam's own Downloads page shows, by scaling the fraction - the
      // stage/download ratio varies slightly per file, so this is an estimate.
      let fraction = state.bytesDownloaded / state.bytesToDownload
      if (state.bytesToStage > 0) {
        const staged = measureSteamDownloadBytes(state.libPath, appId)
        fraction = Math.max(fraction, staged / state.bytesToStage)
      }
      // Capped below 100% - only the manifest flipping to fully installed means done.
      bestFraction = Math.max(bestFraction, Math.min(fraction, 0.999))
      onProgress?.({
        percent: bestFraction * 100,
        bytesDone: bestFraction * state.bytesToDownload,
        bytesTotal: state.bytesToDownload
      })
    }
    await sleep(1500)
  }
}

export async function uninstallSteamGame(det: SteamDetection, appId: string): Promise<void> {
  if (!det.execCommand || !det.root) throw new Error('Steam not found')
  // Confirmed separately from install: the Uninstall dialog does NOT auto-dismiss
  // itself under -silent the way Install does, so the ordinary steamUri() path (which
  // keeps the main library window backgrounded) is safe here without needing the
  // no-silent workaround.
  //
  // Unlike install, the manifest for an app being uninstalled already exists from
  // BEFORE the user clicks anything (it's the currently-installed game's own manifest),
  // so its mere presence can't distinguish "waiting for a click" from "click already
  // happened" the way a fresh install's manifest appearing from nothing can. But Steam
  // does set a distinct StateFlags bit (0x02, "Uninstalling") on that same manifest the
  // instant the confirm click actually happens, well before the files are removed or
  // the manifest disappears - that bit is the real "confirmed" signal that was missing,
  // not a guessed delay, so it's safe to close the window on exactly like install does.
  // No dialog: Steam's own "Uninstall" confirmation call via its API, when reachable.
  // Steam may not be running (it's only started for Steam games) - start it
  // headless and wait for its API rather than falling back to steam://uninstall, which
  // shows Steam's confirmation dialog.
  if (startSteamSilently(det)) await waitForSteamCef(120000)
  const silent = isSteamRunning(det.variant) && (await steamUninstall(appId))
  if (!silent) steamUri(det.execCommand, det.variant, `steam://uninstall/${appId}`)

  let windowClosed = silent
  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    const state = readSteamInstallState(det.root, appId)
    if (!state) return
    if (!windowClosed && (state.stateFlags & 0x02) !== 0) {
      closeSteamWindow()
      windowClosed = true
    }
    await sleep(1000)
  }
  throw new Error('Uninstall timed out - check the Steam client.')
}
