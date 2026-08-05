import { execFileSync, spawn } from 'child_process'
import { accessSync, constants, readdirSync, statSync } from 'fs'
import { userInfo } from 'os'

const REEXEC_GUARD_ENV = 'OMNILAUNCHER_NFC_REEXEC'

/**
 * Supplementary group membership (e.g. `dialout`, granted via Settings > NFC > "Fix
 * permissions" or a manual `usermod`) is fixed for the lifetime of a login session -
 * `usermod` changes /etc/group immediately, but *this already-running desktop session*
 * keeps using the group list it started with until a full logout/login. Confirmed
 * directly: even after `usermod` succeeded and a real KDE logout/login, `groups` still
 * didn't show the new group on one real system - the only thing that actually worked
 * was launching from a shell that had run `newgrp <group>` first, which starts a *new*
 * process with the group list re-read from /etc/group, no logout needed.
 *
 * This does programmatically what that manual `newgrp`+relaunch did by hand: if the
 * reader's device node exists, isn't accessible yet, but /etc/group already lists this
 * account as a member of the group that owns it (i.e. a fix was already applied and is
 * just waiting for a fresh process to pick it up), re-exec the whole app through `sg
 * <group> -c ...` - which, for an account that's a genuine member, requires no password
 * and no logout, just a fresh process. Only ever tried once per launch (guarded by an
 * env var on the re-exec'd child) so a persistently broken environment can't loop.
 *
 * Deliberately does NOT run the pkexec-based fix itself here - that needs an explicit
 * click (Settings > NFC), never an unprompted password dialog at every app launch.
 */
export function maybeReexecForNfcGroupAccess(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env[REEXEC_GUARD_ENV] === '1') return false

  let devicePath: string | null = null
  try {
    const entries = readdirSync('/dev')
    const candidate = entries.find((e) => /^(ttyUSB|ttyACM)\d+$/.test(e))
    devicePath = candidate ? `/dev/${candidate}` : null
  } catch {
    return false
  }
  if (!devicePath) return false

  try {
    accessSync(devicePath, constants.R_OK | constants.W_OK)
    return false // already accessible - nothing to do
  } catch {
    // fall through - not accessible yet, keep checking whether a re-exec would help
  }

  let groupLine: string
  try {
    const gid = statSync(devicePath).gid
    groupLine = execFileSync('getent', ['group', String(gid)], { encoding: 'utf-8' })
  } catch {
    return false
  }
  const [groupName, , , membersRaw] = groupLine.trim().split(':')
  if (!groupName) return false
  const members = (membersRaw ?? '').split(',').filter(Boolean)
  if (!members.includes(userInfo().username)) {
    // Not actually a member yet per /etc/group - re-exec would not help, this needs the
    // explicit, password-prompting fix in Settings first.
    return false
  }

  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const relaunchCmd = [process.execPath, ...process.argv.slice(1)].map(quote).join(' ')

  try {
    const child = spawn('sg', [groupName, '-c', relaunchCmd], {
      detached: true,
      stdio: 'inherit',
      env: { ...process.env, [REEXEC_GUARD_ENV]: '1' }
    })
    child.unref()
  } catch {
    return false
  }
  return true
}
