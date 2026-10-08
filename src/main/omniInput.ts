import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ControllerMode, ControllerModeSetting } from '../shared/types'
import { hostEnv } from './hostEnv'
import { appConfigDir } from './paths'

/**
 * OmniLauncher's own controller layer (resources/omni_input.py) - Steam Input without
 * Steam. While a game runs it takes over every physical controller and presents it as a
 * standard Xbox 360 pad (or as keyboard + mouse, per game), the Steam Controller included.
 */

export interface OmniInputSession {
  /** vid/pid list for SDL_GAMECONTROLLER_IGNORE_DEVICES - the physical controllers the
   *  game must not open directly, or it would see every controller twice. */
  ignore: string
  devices: string[]
  /** Hands the controllers back; resolves once the layer has exited. */
  stop: () => Promise<void>
}

function scriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'omni_input.py')
    : join(app.getAppPath(), 'resources', 'omni_input.py')
}

/** Starts the controller layer and resolves once it has taken the controllers over (or
 *  null if it couldn't start - the game then simply sees the controllers as they are). */
export function startOmniInput(
  mode: ControllerMode,
  steamRoot: string | null
): Promise<OmniInputSession | null> {
  const script = scriptPath()
  if (!existsSync(script)) return Promise.resolve(null)
  const args = ['-I', '-u', script, '--mode', mode]
  if (steamRoot) args.push('--steam-root', steamRoot)

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      // stdin stays open as a lifeline: the daemon exits (handing every controller back)
      // the moment it closes, so it can never outlive OmniLauncher, even after a crash.
      child = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'], env: hostEnv() })
    } catch {
      resolve(null)
      return
    }
    let settled = false
    const exited = new Promise<void>((r) => child.once('exit', () => r()))
    const stop = (): Promise<void> => {
      child.stdin?.end()
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGTERM')
      }, 2000)
      return child.exitCode !== null ? Promise.resolve() : exited
    }
    const done = (session: OmniInputSession | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!session) stop()
      resolve(session)
    }
    const timer = setTimeout(() => done(null), 8000)

    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const line = buffered.split('\n')[0]
      if (!buffered.includes('\n')) return
      try {
        const ready = JSON.parse(line) as { ready?: boolean; ignore?: string; devices?: string[] }
        if (ready.ready) {
          done({ ignore: ready.ignore ?? '', devices: ready.devices ?? [], stop })
          return
        }
      } catch {
        // not the ready line
      }
      done(null)
    })
    child.stderr?.on('data', (chunk: Buffer) => console.log(chunk.toString().trimEnd()))
    child.on('error', () => done(null))
    child.on('exit', () => done(null))
  })
}

/** Environment for a game running on top of the controller layer. */
export function omniInputGameEnv(session: OmniInputSession): NodeJS.ProcessEnv {
  return {
    SDL_GAMECONTROLLER_IGNORE_DEVICES: session.ignore,
    // SDL's HIDAPI drivers talk to controllers over hidraw, around evdev - and around our
    // grab. With them off, the only pads a game can see are the virtual ones.
    SDL_JOYSTICK_HIDAPI: '0'
  }
}

// ---------- per-game mode ----------

function modesFile(): string {
  return join(appConfigDir(), 'controller-modes.json')
}

function readModes(): Record<string, ControllerMode> {
  try {
    return JSON.parse(readFileSync(modesFile(), 'utf-8')) as Record<string, ControllerMode>
  } catch {
    return {}
  }
}

/** The game's override, or 'auto' (the default) to follow its controller support. */
export function getControllerMode(gameId: string): ControllerModeSetting {
  return readModes()[gameId] ?? 'auto'
}

export function setControllerMode(gameId: string, setting: ControllerModeSetting): void {
  const modes = readModes()
  if (setting === 'auto') delete modes[gameId]
  else modes[gameId] = setting
  writeFileSync(modesFile(), JSON.stringify(modes, null, 2))
}

// ---------- in the launcher's own UI ----------

/**
 * The controller layer also runs while OmniLauncher itself is in use (gamepad mode), so a
 * Steam Controller reaches the UI as a standard pad - bumpers, triggers and all - instead of
 * depending on Steam's Desktop Layout keys, which only exist while Steam runs. It steps
 * aside while a game is launching/running (that game's own session takes over) and while
 * Steam runs (Steam drives the controllers then).
 */
let uiSession: OmniInputSession | null = null
let uiStarting: Promise<void> | null = null
let gamesActive = 0

async function syncUiInput(steamRoot: string | null, steamRunning: () => boolean): Promise<void> {
  if (uiStarting) return
  const want = gamesActive === 0 && !steamRunning()
  if (want && !uiSession) {
    uiStarting = (async () => {
      const session = await startOmniInput('gamepad', steamRoot)
      if (session && (gamesActive > 0 || steamRunning())) await session.stop()
      else uiSession = session
    })()
    await uiStarting
    uiStarting = null
  } else if (!want && uiSession) {
    const s = uiSession
    uiSession = null
    await s.stop()
  }
}

export function startUiInput(steamRoot: string | null, steamRunning: () => boolean): void {
  void syncUiInput(steamRoot, steamRunning)
  setInterval(() => void syncUiInput(steamRoot, steamRunning), 3000)
}

/** Before a game launches: frees the controllers (resolves once they are). */
export async function pauseUiInput(): Promise<void> {
  gamesActive++
  if (uiStarting) await uiStarting
  if (uiSession) {
    const s = uiSession
    uiSession = null
    await s.stop()
  }
}

/** After that game is gone - the next sync brings the UI layer back. */
export function resumeUiInput(): void {
  gamesActive = Math.max(0, gamesActive - 1)
}
