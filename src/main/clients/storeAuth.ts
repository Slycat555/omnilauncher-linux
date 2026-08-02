import { execFile } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { loginAmazonWindow, loginEpicWindow, loginGogWindow } from './authWindow'
import { runnerEnv, type HeroicDetection } from './detect'

const execFileP = promisify(execFile)

/**
 * The three login flows are genuinely different - this isn't one function with per-store
 * branches, because the shapes don't line up:
 *   - GOG/Epic: user visits a login page in an app-controlled window; the authorization
 *     code is captured automatically off the resulting redirect/page (see authWindow.ts)
 *     instead of asking the user to copy/paste it.
 *   - Amazon: a device-auth flow - first call gets a URL + serial to visit, the window
 *     captures the code from the redirect after login, then a second call exchanges it
 *     for a token.
 */

// ---------- status ----------

export function gogLoggedIn(det: HeroicDetection): boolean {
  if (!det.configDir) return false
  return existsSync(join(det.configDir, 'gog_store', 'auth.json'))
}

export function epicLoggedIn(det: HeroicDetection): boolean {
  // legendary's own login state file sits next to installed.json, inside the same
  // per-runner config dir Heroic points it at.
  if (!det.configDir) return false
  return existsSync(join(det.configDir, 'legendaryConfig', 'legendary', 'user.json'))
}

/**
 * Unlike GOG/Epic, nile's on-disk credential file name could not be confirmed (no real
 * Amazon account was available to complete a login and observe what gets written) - so
 * this checks for any user-ish JSON file next to the confirmed installed.json rather
 * than asserting a single exact name, and callers should treat a `false` here as "not
 * confirmed", not "definitely logged out".
 */
export function amazonLoggedIn(det: HeroicDetection): boolean {
  if (!det.configDir) return false
  const dir = join(det.configDir, 'nile_config', 'nile')
  return ['user.json', 'auth.json', 'credentials.json'].some((name) => existsSync(join(dir, name)))
}

// ---------- GOG ----------

/**
 * GOG's client-id/secret are the same publicly known values Heroic and every other
 * open-source GOG client (including gogdl itself, when run standalone) uses - they
 * identify the app, not the user, and are not secret credentials.
 */
export const GOG_LOGIN_URL =
  'https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=client2'

export async function loginGog(det: HeroicDetection): Promise<void> {
  if (!det.gogdlBin || !det.configDir) throw new Error('gogdl not found')
  const code = await loginGogWindow(GOG_LOGIN_URL)
  const authPath = join(det.configDir, 'gog_store', 'auth.json')
  const { stdout, stderr } = await execFileP(
    det.gogdlBin,
    ['--auth-config-path', authPath, 'auth', '--code', code],
    { env: { ...process.env, ...runnerEnv(det, 'gogdl') } }
  )
  const out = (stdout + stderr).trim()
  if (out.includes('"error"') || !existsSync(authPath)) {
    throw new Error('GOG rejected the login. Try again.')
  }
}

/** gogdl has no logout subcommand - Heroic itself just deletes the token file, so this
 *  matches that instead of inventing a different mechanism. */
export function logoutGog(det: HeroicDetection): void {
  if (!det.configDir) return
  rmSync(join(det.configDir, 'gog_store', 'auth.json'), { force: true })
}

// ---------- Epic ----------

export const EPIC_LOGIN_URL = 'https://legendary.gl/epiclogin'

export async function loginEpic(det: HeroicDetection): Promise<void> {
  if (!det.legendaryBin) throw new Error('legendary not found')
  const code = await loginEpicWindow(EPIC_LOGIN_URL)
  const { stdout, stderr } = await execFileP(det.legendaryBin, ['auth', '--code', code], {
    env: { ...process.env, ...runnerEnv(det, 'legendary') }
  })
  const out = (stdout + stderr).toLowerCase()
  // legendary checks for an existing valid session before even looking at --code, and
  // if one's already there it prints "stored credentials are still valid" instead of
  // "successfully logged in" - both mean the account ends up authenticated, so both
  // count as success. loginEpicWindow already forced a fresh Epic login page load
  // (there's no cached-session shortcut on that side), the "already valid" case here is
  // purely legendary's own local session cache, not a failure to log in at all.
  if (!out.includes('successfully logged in') && !out.includes('stored credentials are still valid')) {
    throw new Error('Epic rejected the login. Try again.')
  }
}

export async function logoutEpic(det: HeroicDetection): Promise<void> {
  if (!det.legendaryBin) throw new Error('legendary not found')
  await execFileP(det.legendaryBin, ['auth', '--delete'], {
    env: { ...process.env, ...runnerEnv(det, 'legendary') }
  })
}

// ---------- Amazon ----------

export async function loginAmazon(det: HeroicDetection): Promise<void> {
  if (!det.nileBin) throw new Error('nile not found')
  const { stdout } = await execFileP(det.nileBin, ['auth', '--login', '--non-interactive'], {
    env: { ...process.env, ...runnerEnv(det, 'nile') }
  })
  const start = JSON.parse(stdout.trim()) as {
    url: string
    client_id: string
    code_verifier: string
    serial: string
  }
  const code = await loginAmazonWindow(start.url)
  await execFileP(
    det.nileBin,
    [
      'register',
      '--code',
      code,
      '--client-id',
      start.client_id,
      '--code-verifier',
      start.code_verifier,
      '--serial',
      start.serial
    ],
    { env: { ...process.env, ...runnerEnv(det, 'nile') } }
  )
  if (!amazonLoggedIn(det)) {
    throw new Error('Amazon rejected the login. Try again.')
  }
}

export async function logoutAmazon(det: HeroicDetection): Promise<void> {
  if (!det.nileBin) throw new Error('nile not found')
  await execFileP(det.nileBin, ['auth', '--logout'], {
    env: { ...process.env, ...runnerEnv(det, 'nile') }
  })
}
