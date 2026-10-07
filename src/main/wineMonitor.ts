import { execFile } from 'child_process'
import type { WineActivity } from '../shared/types'

const POLL_MS = 2000

/** Wine's own background processes, plus helpers Proton/Steam/wine-mono spawn inside
 *  every prefix - these prove Wine is running, but naming them in the UI would be
 *  meaningless ("services.exe is running"), so they're excluded from the display list. */
const WINE_SYSTEM_EXES = new Set([
  'conhost.exe',
  'explorer.exe',
  'mscorsvw.exe',
  'plugplay.exe',
  'rpcss.exe',
  'rundll32.exe',
  'services.exe',
  'start.exe',
  'steam.exe',
  'svchost.exe',
  'tabtip.exe',
  'wineboot.exe',
  'winedevice.exe',
  'winemenubuilder.exe',
  'xalia.exe'
])

/** Matches the `proton` script itself (run by Steam, umu-launcher, Heroic, Lutris...),
 *  which exists for the whole session including the seconds before wineserver starts. */
const PROTON_SCRIPT = /(^|\/)proton\s+(run|waitforexitandrun|runinprefix|getcompatpath)\b/

let current: WineActivity = { active: false, processes: [] }
let inactiveStreak = 0
let timer: NodeJS.Timeout | null = null

export function getWineActivity(): WineActivity {
  return current
}

/** `ps` lists every process on the host when run natively, but inside the Flatpak
 *  sandbox it only sees the sandbox's own processes - a game launched by Steam/Heroic
 *  would be invisible there. The Flatpak build already has
 *  --talk-name=org.freedesktop.Flatpak, so flatpak-spawn --host reaches the real list. */
function listProcesses(): Promise<string> {
  const psArgs = ['-eo', 'stat=,comm=,args=']
  const [bin, args] = process.env.FLATPAK_ID
    ? ['flatpak-spawn', ['--host', 'ps', ...psArgs]]
    : ['ps', psArgs]
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // A failed scan is treated as "nothing found" rather than locking the UI forever
      // on an error the user can't do anything about.
      resolve(err ? '' : stdout)
    })
  })
}

function scan(output: string): WineActivity {
  let active = false
  const names = new Set<string>()

  for (const line of output.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s*(.*)$/)
    if (!m) continue
    const [, stat, comm, args] = m
    if (stat.startsWith('Z')) continue // zombies are already dead, just not reaped yet

    const lowerComm = comm.toLowerCase()
    // comm is truncated to 15 chars by the kernel, so wine64-preloader shows up as
    // "wine64-preloade" - matching the prefix covers wine, wine64, wineserver and both
    // preloaders regardless.
    const isWineBinary = lowerComm.startsWith('wine')
    // Every Windows process under Wine shows its .exe name as comm (e.g. "Apotheon.exe").
    // Long names lose the ".exe" to the 15-char truncation, but wineserver is always
    // running alongside them anyway, so the session is still detected.
    const isWindowsExe = lowerComm.endsWith('.exe')
    const isProtonScript = PROTON_SCRIPT.test(args)

    if (!isWineBinary && !isWindowsExe && !isProtonScript) continue
    active = true
    if (isWindowsExe && !WINE_SYSTEM_EXES.has(lowerComm)) names.add(comm)
  }

  return { active, processes: [...names].sort((a, b) => a.localeCompare(b)) }
}

function sameActivity(a: WineActivity, b: WineActivity): boolean {
  return (
    a.active === b.active &&
    a.processes.length === b.processes.length &&
    a.processes.every((p, i) => p === b.processes[i])
  )
}

/** Polls for any Wine/Proton process on the system - not just games this app launched,
 *  since a game started from Steam, Heroic or Lutris directly is just as able to receive
 *  a stray click or controller press meant for the launcher. */
export function startWineMonitor(onChange: (activity: WineActivity) => void): void {
  if (timer) return
  const tick = async (): Promise<void> => {
    const next = scan(await listProcesses())
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
  void tick()
  timer = setInterval(() => void tick(), POLL_MS)
}
