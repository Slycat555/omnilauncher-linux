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
  stop: () => void
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
    const stop = (): void => {
      child.stdin?.end()
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGTERM')
      }, 2000)
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
