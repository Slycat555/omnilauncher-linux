import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { WineActivity } from '../shared/types'
import { appConfigDir } from './paths'

const POLL_MS = 2000
/** Slower while a game runs - it only needs to notice the game closing, and each scan
 *  spawns ps/cat on the host. */
const POLL_IN_GAME_MS = 5000

/** Wine's own background processes and launcher plumbing - present whenever a prefix
 *  is up, including while Steam runs a game's install scripts or Heroic runs winetricks,
 *  so they never count as "a game is running". */
const NON_GAME_EXES = new Set([
  'conhost.exe',
  'cmd.exe',
  'explorer.exe',
  'mscorsvw.exe',
  'msiexec.exe',
  'plugplay.exe',
  'reg.exe',
  'regedit.exe',
  'regsvr32.exe',
  'rpcss.exe',
  'rundll32.exe',
  'services.exe',
  'start.exe',
  'steam.exe',
  'svchost.exe',
  'tabtip.exe',
  'wineboot.exe',
  'winecfg.exe',
  'winedevice.exe',
  'winemenubuilder.exe',
  'xalia.exe'
])

/** Installers, redistributables, uninstallers and crash reporters - Steam runs these
 *  through Proton after a download (install scripts), and they're never the game. */
const NON_GAME_EXE_RE =
  /^(iscriptevaluator|vc_?redist|vcredist|dxsetup|dxwebsetup|dotnet|ndp\d|unins\d*|setup|install|crashpad|.*crashhandler|.*crashreport|steamerrorreporter|easyanticheat.*setup|uplayinstaller|epicinstaller)/i

/** Where a real game's executable can't be: Wine's own system folders, Steam's helper
 *  folder inside the prefix, redistributable folders, temp and the winetricks cache. */
const NON_GAME_PATH_RE =
  /\\windows\\(system32|syswow64)\\|\\program files( \(x86\))?\\steam\\|_commonredist|\\temp\\|[\\/]\.cache[\\/]|winetricks/i

/** Steam work that runs under a reaper but isn't the game itself. */
const STEAM_NON_GAME_RE =
  /iscriptevaluator|legacycompat|steam-runtime-(check-requirements|launcher-service)|\bunins\d*\.exe|_commonredist/i

let current: WineActivity = { active: false, gameIds: [] }
let inactiveStreak = 0
let timer: NodeJS.Timeout | null = null

export function getWineActivity(): WineActivity {
  return current
}

/** `ps` and /proc list every process on the host when run natively, but inside the
 *  Flatpak sandbox only the sandbox's own - a game launched by Steam/Heroic would be
 *  invisible there. The Flatpak build already has --talk-name=org.freedesktop.Flatpak,
 *  so flatpak-spawn --host reaches the real ones. */
function runOnHost(bin: string, args: string[]): Promise<string> {
  const [cmd, cmdArgs] = process.env.FLATPAK_ID
    ? ['flatpak-spawn', ['--host', bin, ...args]]
    : [bin, args]
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // A failed read is treated as "nothing found" rather than locking the UI forever
      // on an error the user can't do anything about.
      resolve(err ? '' : stdout)
    })
  })
}

/** Whether a game launcher started this process, from markers every launcher passes
 *  down through Proton (verified reading a umu-launched Wine process's environment):
 *  Steam sets a numeric SteamGameId for its games (umu sets the literal "default", so
 *  that alone proves nothing), OmniLauncher's own launches carry OMNILAUNCHER_GAME_ID,
 *  and Heroic/umu set GAMEID - except for Heroic's winetricks runs. */
/** Shortcut app id -> OmniLauncher game id, for GOG games launched through Steam. */
function shortcutGameIds(): Map<string, string> {
  try {
    const map = JSON.parse(readFileSync(join(appConfigDir(), 'steam-shortcuts.json'), 'utf-8'))
    return new Map(Object.entries(map).map(([gameId, appId]) => [String(appId), gameId]))
  } catch {
    return new Map()
  }
}

/** Steam's id for an app - a plain app id, or a non-Steam shortcut's (mapped back to the
 *  GOG game it launches). Shortcut *game* ids are 64-bit: the app id is the high 32 bits. */
function steamAppGameId(id: string, shortcuts: Map<string, string>): string {
  const appId = id.length > 10 ? String(BigInt(id) >> 32n) : id
  return shortcuts.get(appId) ?? `steam:${appId}`
}

/** Which library game launched this process, from markers every launcher passes down
 *  through Proton (verified reading a umu-launched Wine process's environment), or null
 *  when it isn't a game launch at all (e.g. Heroic's winetricks). 'unknown' = a game, but
 *  not one we can match to the library. */
function launchedGameId(environ: string, shortcuts: Map<string, string>): string | null {
  const env = new Map<string, string>()
  for (const entry of environ.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1))
  }
  const own = env.get('OMNILAUNCHER_GAME_ID')
  if (own) return own
  // Steam's own games and shortcuts set a numeric SteamGameId; umu sets the literal
  // "default", which identifies nothing.
  const steamGameId = env.get('SteamGameId') ?? ''
  if (/^[1-9]\d*$/.test(steamGameId)) return steamAppGameId(steamGameId, shortcuts)
  const umuId = env.get('GAMEID') ?? env.get('UMU_ID')
  if (!umuId || umuId.startsWith('winetricks')) return null
  const store = env.get('STORE')
  const numeric = umuId.match(/^umu-(\d+)$/)?.[1]
  if (numeric && store === 'gog') return `gog:${numeric}`
  return 'unknown'
}

/** Games OmniLauncher is installing or uninstalling right now - whatever Steam or Wine
 *  runs for them meanwhile (uninstall scripts, redistributables) isn't the game. */
let isBusy: (gameId: string) => boolean = () => false

async function scan(): Promise<WineActivity> {
  const shortcuts = shortcutGameIds()
  const gameIds = new Set<string>()
  const candidates: string[] = []
  for (const line of (await runOnHost('ps', ['-eo', 'pid=,stat=,comm=,args='])).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/)
    if (!m) continue
    const [, pid, stat, comm, args] = m
    if (stat.startsWith('Z')) continue // zombies are already dead, just not reaped yet

    // Steam runs every game it launches - native Linux or Proton, Steam app or non-Steam
    // shortcut - under "reaper SteamLaunch AppId=<id>", so that alone identifies it.
    const reaper = args.match(/\breaper\b.*\bSteamLaunch\b.*\bAppId=(\d+)/)
    // Steam also uses a reaper for an app's install/uninstall scripts and its runtime
    // setup - those aren't the game.
    if (reaper && STEAM_NON_GAME_RE.test(args)) continue
    if (reaper) {
      gameIds.add(steamAppGameId(reaper[1], shortcuts))
      continue
    }

    const lower = comm.toLowerCase()
    // Every Windows process under Wine shows its .exe name as comm (e.g. "Apotheon.exe").
    // The kernel truncates comm to 15 chars, so a long name loses its ".exe" - then the
    // Wine-style path at the start of args (C:\..., Z:\...) is checked instead. Matching
    // ".exe" anywhere in args would also catch the launcher scripts themselves
    // ("proton waitforexitandrun Game.exe").
    const isExe =
      lower.endsWith('.exe') || (comm.length === 15 && /^[a-z]:\\.*?\.exe\b/i.test(args))
    if (!isExe) continue
    if (NON_GAME_EXES.has(lower) || NON_GAME_EXE_RE.test(lower)) continue
    if (NON_GAME_PATH_RE.test(args)) continue
    candidates.push(pid)
  }

  for (const pid of candidates) {
    const id = launchedGameId(await runOnHost('cat', [`/proc/${pid}/environ`]), shortcuts)
    if (id) gameIds.add(id)
  }
  for (const id of [...gameIds]) if (isBusy(id)) gameIds.delete(id)
  // A known game makes an 'unknown' entry for the same session redundant.
  if (gameIds.size > 1) gameIds.delete('unknown')
  return { active: gameIds.size > 0, gameIds: [...gameIds].sort() }
}

function sameActivity(a: WineActivity, b: WineActivity): boolean {
  return (
    a.active === b.active &&
    a.gameIds.length === b.gameIds.length &&
    a.gameIds.every((p, i) => p === b.gameIds[i])
  )
}

/** Polls for a real Windows game running under Wine/Proton - launched by Steam, Heroic or
 *  this app, not just games this app launched itself - while ignoring Wine activity that
 *  isn't a game (install scripts, winetricks, redistributables, an idle wineserver). */
export function startWineMonitor(
  onChange: (activity: WineActivity) => void,
  busy?: (gameId: string) => boolean
): void {
  if (timer) return
  if (busy) isBusy = busy
  const tick = async (): Promise<void> => {
    const next = await scan()
    if (!next.active && current.active) {
      // A game can briefly have no Wine process at all while a launcher .exe hands off
      // to the real game, or while Proton restarts wineserver - require two empty scans
      // in a row so the UI doesn't flash unlocked in between.
      if (++inactiveStreak < 2) return
    }
    inactiveStreak = 0
    if (sameActivity(next, current)) return
    current = next
    onChange(current)
  }
  const loop = async (): Promise<void> => {
    await tick()
    timer = setTimeout(() => void loop(), current.active ? POLL_IN_GAME_MS : POLL_MS)
  }
  void loop()
}
