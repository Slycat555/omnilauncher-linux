import { execFile } from 'child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { ControllerSetupStatus, NfcFixResult } from '../shared/types'
import { hostEnv } from './hostEnv'
import { appConfigDir } from './paths'

const execFileP = promisify(execFile)

/**
 * What the controller layer (resources/omni_input.py) needs from the system, and a
 * one-prompt fix for it. Bazzite/SteamOS ship all of it; most distros don't:
 *  - python-evdev, which the layer is written against;
 *  - write access to /dev/uinput, for the virtual pad it presents;
 *  - read/write access to the controllers themselves (evdev + hidraw - the Steam
 *    Controller is driven over hidraw).
 * Access comes from logind's uaccess ACLs. Distros' steam-devices packages carry the
 * rules, but they only reach devices that appear after the package was installed (or a
 * udevadm trigger) - so a Steam installed in this boot leaves the controller root-only.
 */

/** 70-, not 99-: TAG+="uaccess" is acted on by 73-seat-late.rules, so a later rule file
 *  sets the tag after the ACLs were already applied and changes nothing. */
const RULE_PATH = '/etc/udev/rules.d/70-omnilauncher-controllers.rules'
const RULE_CONTENT =
  'KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"\n' +
  'SUBSYSTEM=="input", ENV{ID_INPUT_JOYSTICK}=="1", TAG+="uaccess"\n' +
  'SUBSYSTEM=="input", ATTRS{id/vendor}=="28de", MODE="0660", TAG+="uaccess"\n' +
  'KERNEL=="hidraw*", ATTRS{idVendor}=="28de", MODE="0660", TAG+="uaccess"\n' +
  'KERNEL=="hidraw*", KERNELS=="*28DE:*", MODE="0660", TAG+="uaccess"\n'
const MODULES_PATH = '/etc/modules-load.d/omnilauncher-uinput.conf'

/** Package-manager command installing python-evdev, per distro family. */
const EVDEV_INSTALLERS: { bin: string; cmd: string }[] = [
  { bin: 'dnf', cmd: 'dnf install -y python3-evdev' },
  { bin: 'apt-get', cmd: 'DEBIAN_FRONTEND=noninteractive apt-get install -y python3-evdev' },
  { bin: 'pacman', cmd: 'pacman -S --needed --noconfirm python-evdev' },
  { bin: 'zypper', cmd: 'zypper --non-interactive install python3-evdev' },
  { bin: 'xbps-install', cmd: 'xbps-install -y python3-evdev' },
  { bin: 'eopkg', cmd: 'eopkg install -y python-evdev' }
]

function canReadWrite(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

/** Controller device nodes this session should be able to open: joystick evdev nodes
 *  (udev's ID_INPUT_JOYSTICK) and everything from Valve (28de), evdev and hidraw. */
function controllerNodes(): string[] {
  const nodes: string[] = []
  try {
    for (const name of readdirSync('/sys/class/input')) {
      if (!name.startsWith('event')) continue
      const sys = join('/sys/class/input', name)
      const vendor = readText(join(sys, 'device', 'id', 'vendor')).trim()
      const dev = readText(join(sys, 'dev')).trim()
      const joystick = /^E:ID_INPUT_JOYSTICK=1$/m.test(readText(`/run/udev/data/c${dev}`))
      if (vendor === '28de' || joystick) nodes.push(`/dev/input/${name}`)
    }
  } catch {
    // no /sys/class/input
  }
  try {
    for (const name of readdirSync('/sys/class/hidraw')) {
      const uevent = readText(join('/sys/class/hidraw', name, 'device', 'uevent'))
      if (/HID_ID=[0-9A-F]+:000028DE:/i.test(uevent)) nodes.push(`/dev/${name}`)
    }
  } catch {
    // no hidraw
  }
  return nodes.filter((n) => existsSync(n))
}

async function hasEvdev(): Promise<boolean> {
  try {
    await execFileP('python3', ['-I', '-c', 'import evdev'], { env: hostEnv() })
    return true
  } catch {
    return false
  }
}

export async function controllerSetupStatus(): Promise<ControllerSetupStatus> {
  const blocked = controllerNodes().filter((n) => !canReadWrite(n))
  const status = {
    evdev: await hasEvdev(),
    uinput: canReadWrite('/dev/uinput'),
    devices: blocked.length === 0,
    ok: false
  }
  status.ok = status.evdev && status.uinput && status.devices
  return status
}

async function which(bin: string): Promise<boolean> {
  try {
    await execFileP('sh', ['-c', 'command -v "$1"', '--', bin])
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fixes whatever controllerSetupStatus() found missing in a single pkexec (polkit)
 * prompt - installs python-evdev with the distro's package manager, adds the uaccess
 * rule above, loads uinput (now and at boot) and re-triggers udev so devices already
 * plugged in get their ACLs - then checks again rather than trusting exit codes.
 */
export async function fixControllerSetup(): Promise<NfcFixResult> {
  const before = await controllerSetupStatus()
  if (before.ok) return { ok: true, message: 'Controller support is already set up.' }

  const steps: string[] = []
  let installer: string | null = null
  if (!before.evdev) {
    for (const i of EVDEV_INSTALLERS) {
      if (await which(i.bin)) {
        installer = i.cmd
        break
      }
    }
    if (installer) steps.push(installer)
  }
  if (!before.uinput || !before.devices) {
    const tmpPath = join(tmpdir(), 'omnilauncher-controllers.rules')
    try {
      writeFileSync(tmpPath, RULE_CONTENT)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    steps.push(
      `cp '${tmpPath}' '${RULE_PATH}'`,
      `echo uinput > '${MODULES_PATH}'`,
      'modprobe uinput || true',
      'udevadm control --reload-rules',
      'udevadm trigger --subsystem-match=misc --subsystem-match=input --subsystem-match=hidraw',
      'udevadm settle || true'
    )
  }
  if (steps.length === 0) {
    return {
      ok: false,
      message:
        'python-evdev is missing and no supported package manager was found - install ' +
        "your distro's python3-evdev (or python-evdev) package, then restart OmniLauncher."
    }
  }

  try {
    await execFileP('pkexec', ['sh', '-c', `set -e; ${steps.join('; ')}`], { env: hostEnv() })
  } catch (err) {
    const code = Number((err as NodeJS.ErrnoException)?.code)
    if (code === 126 || code === 127) {
      return { ok: false, message: 'Permission request was cancelled.' }
    }
    return {
      ok: false,
      message: `Could not set up controller support automatically (${err instanceof Error ? err.message : String(err)}).`
    }
  }

  let after = before
  for (let i = 0; i < 10; i++) {
    after = await controllerSetupStatus()
    if (after.ok) return { ok: true, message: 'Controller support is set up.' }
    await sleep(300)
  }
  if (!after.evdev) {
    return {
      ok: false,
      message: installer
        ? 'python-evdev could not be installed - install it with your package manager.'
        : "Install your distro's python3-evdev (or python-evdev) package."
    }
  }
  return {
    ok: false,
    message: 'Applied the fix, but this system needs a reboot (or replugging the controller) first.'
  }
}

/** The automatic fix is offered once at startup; if it's declined, it isn't asked again
 *  (Settings still has the button). */
function promptedFile(): string {
  return join(appConfigDir(), 'controller-setup-prompted')
}

export async function autoFixControllerSetup(): Promise<NfcFixResult | null> {
  const status = await controllerSetupStatus()
  if (status.ok || existsSync(promptedFile())) return null
  try {
    writeFileSync(promptedFile(), '')
  } catch {
    // still try once
  }
  return fixControllerSetup()
}
