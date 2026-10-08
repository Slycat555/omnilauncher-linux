import { execFile } from 'child_process'
import { screen } from 'electron'

export interface DisplayMode {
  width: number
  height: number
  refresh: number
}

interface KScreenMode {
  id: string
  size: { width: number; height: number }
  refreshRate: number
}

interface KScreenOutput {
  enabled: boolean
  priority?: number
  currentModeId?: string
  modes?: KScreenMode[]
}

function runOnHost(bin: string, args: string[]): Promise<string> {
  const [cmd, cmdArgs] = process.env.FLATPAK_ID
    ? ['flatpak-spawn', ['--host', bin, ...args]]
    : [bin, args]
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout)
    )
  })
}

/** True inside a gamescope session (Steam Deck / Bazzite Game Mode): the whole session is
 *  already gamescope, so games must not be wrapped in a second, nested one. */
export function inGamescopeSession(): boolean {
  return !!process.env.GAMESCOPE_WAYLAND_DISPLAY || process.env.XDG_CURRENT_DESKTOP === 'gamescope'
}

/**
 * The primary monitor's native resolution and the highest refresh rate it supports at that
 * resolution. KDE's kscreen-doctor lists every mode an output supports; Electron's screen
 * API only knows the *current* refresh rate (and reports scaled sizes), so it's only the
 * fallback when kscreen isn't available.
 */
export async function detectDisplayMode(): Promise<DisplayMode> {
  try {
    const outputs = (JSON.parse(await runOnHost('kscreen-doctor', ['-j'])).outputs ??
      []) as KScreenOutput[]
    const enabled = outputs.filter((o) => o.enabled)
    const output = enabled.find((o) => o.priority === 1) ?? enabled[0]
    const modes = output?.modes ?? []
    const current = modes.find((m) => m.id === output?.currentModeId)
    if (current) {
      const sameSize = modes.filter(
        (m) => m.size.width === current.size.width && m.size.height === current.size.height
      )
      return {
        width: current.size.width,
        height: current.size.height,
        refresh: Math.round(Math.max(...sameSize.map((m) => m.refreshRate)))
      }
    }
  } catch {
    // not KDE / kscreen-doctor missing - fall through
  }
  const display = screen.getPrimaryDisplay()
  return {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
    refresh: Math.round(display.displayFrequency || 60)
  }
}

/** Fullscreen gamescope at the monitor's native resolution (rendered and output) and its
 *  maximum refresh rate - ends with "--", ready to prefix a game command. */
export async function gamescopeArgs(): Promise<string[]> {
  const { width, height, refresh } = await detectDisplayMode()
  return [
    '-W',
    `${width}`,
    '-H',
    `${height}`,
    '-w',
    `${width}`,
    '-h',
    `${height}`,
    '-r',
    `${refresh}`,
    // Nested in the desktop, mouse-look games get jittery, inaccurate absolute pointer
    // motion unless gamescope grabs the cursor and passes relative movement through.
    '--force-grab-cursor',
    '-f',
    '--'
  ]
}

/** Exactly what OmniLauncher inserts into launch options - recognised again so it can be
 *  updated (new monitor/refresh) or removed (setting turned off) without touching
 *  anything the user wrote. */
const OURS = /gamescope -W \d+ -H \d+ -w \d+ -h \d+ -r \d+( --force-grab-cursor)? -f --\s*/g

/**
 * Adds (or removes, when `args` is null) gamescope to a Steam launch-options string,
 * keeping whatever else is there: `VAR=x %command% -arg` becomes
 * `VAR=x gamescope ... -- %command% -arg`; options without %command% are treated as game
 * arguments, which is how Steam reads them.
 */
export function withGamescope(options: string, args: string[] | null): string {
  let cleaned = options.replace(OURS, '').replace(/\s+/g, ' ').trim()
  // A bare %command% is what adding gamescope to empty options leaves behind on removal.
  if (cleaned === '%command%') cleaned = ''
  if (!args) return cleaned
  const prefix = `gamescope ${args.join(' ')}`
  if (cleaned.includes('%command%')) return cleaned.replace('%command%', `${prefix} %command%`)
  return cleaned ? `${prefix} %command% ${cleaned}` : `${prefix} %command%`
}
