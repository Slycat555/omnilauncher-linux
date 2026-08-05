import { execFile } from 'child_process'
import { accessSync, constants, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { NfcFixResult } from '../../shared/types'

const execFileP = promisify(execFile)

const RULE_PATH = '/etc/udev/rules.d/99-omnilauncher-nfc.rules'
/**
 * TAG+="uaccess" is systemd-logind's seat-based ACL mechanism - the same one that
 * already silently grants a logged-in desktop user access to their webcam, sound card,
 * etc. with no group membership involved at all, and (unlike group membership) can take
 * effect immediately rather than only on the next login. It is NOT reliable on every
 * system, though - confirmed directly: on one real Fedora KDE install, this rule was
 * installed and udevadm-triggered successfully (pkexec returned success) and the device
 * still was not openable until a full login cycle. Rather than bet on one mechanism,
 * fixNfcPermissions() below applies this *and* the classic group-membership fix in the
 * same pkexec prompt, and actually checks afterward whether the device is openable yet
 * instead of trusting either command's exit code - see its own doc comment.
 *
 * Scoped to ttyUSB* and ttyACM* generally, matching findDevicePath() below: PN532
 * USB-serial dongles have no distinct vendor/product id to filter on more precisely
 * (that varies by board), so this is exactly as broad as the app's own device detection
 * already is, not broader.
 */
const RULE_CONTENT =
  'SUBSYSTEM=="tty", KERNEL=="ttyUSB*", TAG+="uaccess"\n' +
  'SUBSYSTEM=="tty", KERNEL=="ttyACM*", TAG+="uaccess"\n'

/** Duplicated from nfcManager.ts's own copy rather than imported - this needs to keep
 *  working as a standalone check independent of whatever state the reader/watcher is
 *  currently in (mid-reconnect, closed, etc.), not tied to the live Pn532 instance. */
function findDevicePath(): string | null {
  try {
    const entries = readdirSync('/dev')
    const candidate = entries.find((e) => /^(ttyUSB|ttyACM)\d+$/.test(e))
    return candidate ? `/dev/${candidate}` : null
  } catch {
    return null
  }
}

/** Whether this (unprivileged) process could open the device right now - checked with a
 *  plain access(2) call, which Linux evaluates against POSIX ACLs (what a uaccess rule
 *  grants) as well as classic owner/group bits, so it reflects either fix landing. */
function canAccessDevice(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Not every distro calls the serial-port group "dialout" (a few use "uucp") - reading
 *  it directly off the device's own gid, instead of hardcoding a name, is what actually
 *  makes the group-membership fallback below work on "all Linux distros" as opposed to
 *  just the ones that happen to match one specific assumption. */
async function ownerGroupName(path: string): Promise<string | null> {
  try {
    const gid = statSync(path).gid
    const { stdout } = await execFileP('getent', ['group', String(gid)])
    return stdout.split(':')[0]?.trim() || null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Applies both known fixes for "the device node exists but this account can't open it"
 * in a single pkexec (polkit) prompt, then actually checks whether that worked instead
 * of reporting success just because the elevated commands exited 0:
 *   1. A uaccess udev rule (see RULE_CONTENT) - takes effect immediately when the
 *      system's session/seat management supports it, no logout needed.
 *   2. Group membership in whatever group actually owns the device - the universal
 *      fallback that works on every distro, but only takes effect on the *next* full
 *      login (this is a Linux session model limitation, not something any app,
 *      including this one, can work around).
 * Both together, plus real verification, is what makes this actually portable across
 * distros/session managers with different quirks, rather than betting on one specific
 * mechanism and reporting success whether or not it actually did anything.
 */
export async function fixNfcPermissions(): Promise<NfcFixResult> {
  const devicePath = findDevicePath()
  if (!devicePath) {
    return { ok: false, message: 'No reader detected - make sure it is plugged in, then try again.' }
  }
  if (canAccessDevice(devicePath)) {
    return { ok: true, message: 'Already accessible - nothing to fix.' }
  }

  const groupName = (await ownerGroupName(devicePath)) ?? 'dialout'
  const username = userInfo().username

  const tmpPath = join(tmpdir(), 'omnilauncher-nfc.rules')
  try {
    writeFileSync(tmpPath, RULE_CONTENT)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to prepare udev rule' }
  }

  try {
    await execFileP('pkexec', [
      'sh',
      '-c',
      // $1-$4 are passed positionally (see '--' below), never interpolated into this
      // string, so none of them can reach the shell as anything but a literal arg.
      'cp "$1" "$2" && udevadm control --reload-rules && udevadm trigger && usermod -aG "$3" "$4"',
      '--',
      tmpPath,
      RULE_PATH,
      groupName,
      username
    ])
  } catch (err) {
    // pkexec's own exit codes (not just anything the wrapped script returns): 126 means
    // the user dismissed/declined the auth prompt, 127 means authorization was not
    // obtained - both are a cancellation, not a real failure. child_process sets .code
    // to the exit status (a number) when the process ran and exited non-zero, but to a
    // string errno like 'ENOENT' if pkexec itself couldn't be spawned at all -
    // Number(...) normalizes both instead of string-matching a message format that
    // isn't guaranteed to contain the code as text.
    const code = Number((err as NodeJS.ErrnoException)?.code)
    if (code === 126 || code === 127) {
      return { ok: false, message: 'Permission request was cancelled.' }
    }
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      message:
        `Could not fix permissions automatically (${message}). Run ` +
        `"sudo usermod -aG ${groupName} $USER" yourself, then log out and back in.`
    }
  }

  // The uaccess ACL can take a moment to actually land even after udevadm trigger
  // returns - give it a real few seconds before concluding this session needs a
  // logout, instead of always assuming the worse case even on systems where it works
  // instantly (which the earlier version of this function did, incorrectly).
  for (let i = 0; i < 10; i++) {
    if (canAccessDevice(devicePath)) {
      return { ok: true, message: 'Permission fixed - the reader should connect within a few seconds.' }
    }
    await sleep(300)
  }

  return {
    ok: true,
    message:
      `Applied a fix, but this system needs a full log out and back in before it takes ` +
      `effect (added your account to the "${groupName}" group as a fallback). Log out ` +
      'and back in, then it should just work.'
  }
}
