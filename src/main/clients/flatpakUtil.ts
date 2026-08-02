import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export async function flatpakAppInstalled(appId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP('flatpak', [
      'list',
      '--app',
      '--columns=application'
    ])
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .includes(appId)
  } catch {
    return false
  }
}

/** Returns the host filesystem path to the flatpak app's install root (parent of `files/`). */
export async function flatpakShowLocation(appId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('flatpak', ['info', '--show-location', appId])
    const loc = stdout.trim()
    return loc.length > 0 ? loc : null
  } catch {
    return null
  }
}
