import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { ClientVariant, DetectionResult } from '../../shared/types'
import { existsOrNull } from '../paths'
import { flatpakAppInstalled, flatpakShowLocation } from './flatpakUtil'

const execFileP = promisify(execFile)

const HEROIC_FLATPAK_ID = 'com.heroicgameslauncher.hgl'
const STEAM_FLATPAK_ID = 'com.valvesoftware.Steam'

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('sh', ['-c', `command -v ${bin}`])
    const p = stdout.trim()
    return p.length > 0 ? p : null
  } catch {
    return null
  }
}

export interface SteamDetection {
  present: boolean
  variant: ClientVariant
  root: string | null
  /** argv prefix to spawn/exec the Steam client, e.g. ['steam'] or ['flatpak','run',id] */
  execCommand: string[] | null
}

export async function detectSteam(): Promise<SteamDetection> {
  const nativeRoot = join(homedir(), '.local', 'share', 'Steam')
  const hasNativeRoot = existsSync(join(nativeRoot, 'steamapps'))
  const nativeBin = existsOrNull('/usr/bin/steam') ?? (await which('steam'))
  if (hasNativeRoot || nativeBin) {
    return { present: true, variant: 'native', root: nativeRoot, execCommand: ['steam'] }
  }
  if (await flatpakAppInstalled(STEAM_FLATPAK_ID)) {
    const root = join(homedir(), '.var', 'app', STEAM_FLATPAK_ID, '.local', 'share', 'Steam')
    return {
      present: true,
      variant: 'flatpak',
      root: existsOrNull(join(root, 'steamapps')) ? root : root,
      execCommand: ['flatpak', 'run', STEAM_FLATPAK_ID]
    }
  }
  return { present: false, variant: null, root: null, execCommand: null }
}

export interface HeroicDetection {
  present: boolean
  variant: ClientVariant
  configDir: string | null
  legendaryBin: string | null
  gogdlBin: string | null
  nileBin: string | null
  /** extra env vars needed to run the bundled binaries against the right config (flatpak sandbox home) */
  env: NodeJS.ProcessEnv
}

export type HeroicRunner = 'legendary' | 'gogdl' | 'nile'

/**
 * Heroic gives each backend CLI its own XDG_CONFIG_HOME under the Heroic config dir,
 * and each tool then creates its own subfolder inside it:
 *   <heroic>/legendaryConfig/legendary, <heroic>/gogdlConfig/heroic_gogdl, <heroic>/nile_config/nile
 * Pointing them anywhere else makes them create a second, empty state directory - the
 * tool then looks "logged out" and loses track of what is already installed.
 */
const RUNNER_CONFIG_SUBDIR: Record<HeroicRunner, string> = {
  legendary: 'legendaryConfig',
  gogdl: 'gogdlConfig',
  nile: 'nile_config'
}

export function runnerEnv(det: HeroicDetection, runner: HeroicRunner): NodeJS.ProcessEnv {
  if (!det.configDir) return det.env
  return {
    ...det.env,
    XDG_CONFIG_HOME: join(det.configDir, RUNNER_CONFIG_SUBDIR[runner])
  }
}

/** Path where gogdl caches the build manifest it diffs against on the next download. */
export function gogdlManifestPath(det: HeroicDetection, appId: string): string | null {
  if (!det.configDir) return null
  return join(det.configDir, RUNNER_CONFIG_SUBDIR.gogdl, 'heroic_gogdl', 'manifests', appId)
}

/** legendary's own record of what it installed - has the exe filename, which nothing
 *  else surfaces (Heroic's cache/UnifiedGame only carry the install directory). */
export function legendaryInstalledJsonPath(det: HeroicDetection): string | null {
  if (!det.configDir) return null
  return join(det.configDir, RUNNER_CONFIG_SUBDIR.legendary, 'legendary', 'installed.json')
}

/** Heroic's own configured default install directory (its Settings > General >
 *  "Default Installation Path") - read directly from its config.json rather than using
 *  a separate app-owned directory. Installing anywhere else was a real bug: this app's
 *  installs landed in its own settings-configured folder instead of wherever real
 *  Heroic actually looks, so Heroic's own UI showed those exact titles as "Game not
 *  available" (confirmed directly against a real Heroic library - Rocket League,
 *  Cuphead, Boxes: Lost Fragments, and KOTOR all showed that state, matching every game
 *  installed through this app rather than through Heroic itself). legendary/gogdl/nile
 *  are the same actual binaries and config Heroic uses (see runnerEnv above) - the
 *  install location is the one place this app was diverging from "just link into what
 *  Heroic already does" instead of actually doing that. */
export function heroicDefaultInstallPath(det: HeroicDetection): string {
  const fallback = join(homedir(), 'Games', 'Heroic')
  if (!det.configDir) return fallback
  try {
    const raw = readFileSync(join(det.configDir, 'config.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { defaultInstallPath?: unknown }
    return typeof parsed.defaultInstallPath === 'string' && parsed.defaultInstallPath
      ? parsed.defaultInstallPath
      : fallback
  } catch {
    return fallback
  }
}

const NATIVE_HEROIC_RESOURCE_ROOTS = [
  '/opt/Heroic/resources',
  '/usr/lib/heroic/resources',
  '/usr/lib64/heroic/resources',
  '/usr/share/heroic/resources'
]

export async function detectHeroic(): Promise<HeroicDetection> {
  if (await flatpakAppInstalled(HEROIC_FLATPAK_ID)) {
    const loc = await flatpakShowLocation(HEROIC_FLATPAK_ID)
    const appHome = join(homedir(), '.var', 'app', HEROIC_FLATPAK_ID)
    const configDir = existsOrNull(join(appHome, 'config', 'heroic'))
    let legendaryBin: string | null = null
    let gogdlBin: string | null = null
    let nileBin: string | null = null
    if (loc) {
      const binRoot = join(
        loc,
        'files',
        'bin',
        'heroic',
        'resources',
        'app.asar.unpacked',
        'build',
        'bin',
        'x64',
        'linux'
      )
      legendaryBin = existsOrNull(join(binRoot, 'legendary'))
      gogdlBin = existsOrNull(join(binRoot, 'gogdl'))
      nileBin = existsOrNull(join(binRoot, 'nile'))
    }
    return {
      present: true,
      variant: 'flatpak',
      configDir,
      legendaryBin,
      gogdlBin,
      nileBin,
      env: {
        XDG_CACHE_HOME: join(appHome, 'cache')
      }
    }
  }

  const nativeConfigDir = existsOrNull(join(homedir(), '.config', 'heroic'))
  let legendaryBin: string | null = null
  let gogdlBin: string | null = null
  let nileBin: string | null = null
  for (const root of NATIVE_HEROIC_RESOURCE_ROOTS) {
    const binRoot = join(root, 'app.asar.unpacked', 'build', 'bin', 'x64', 'linux')
    legendaryBin = legendaryBin ?? existsOrNull(join(binRoot, 'legendary'))
    gogdlBin = gogdlBin ?? existsOrNull(join(binRoot, 'gogdl'))
    nileBin = nileBin ?? existsOrNull(join(binRoot, 'nile'))
  }
  // Fall back to system-installed CLI tools on PATH (e.g. pip/AUR legendary)
  legendaryBin = legendaryBin ?? (await which('legendary'))
  gogdlBin = gogdlBin ?? (await which('gogdl'))
  nileBin = nileBin ?? (await which('nile'))

  const heroicOnPath = await which('heroic')
  const present = !!(nativeConfigDir || legendaryBin || gogdlBin || nileBin || heroicOnPath)

  return {
    present,
    variant: present ? 'native' : null,
    configDir: nativeConfigDir,
    legendaryBin,
    gogdlBin,
    nileBin,
    env: {}
  }
}

export async function detectAll(): Promise<DetectionResult> {
  const [steam, heroic] = await Promise.all([detectSteam(), detectHeroic()])
  return {
    steam: {
      present: steam.present,
      variant: steam.variant,
      root: steam.root,
      detail: steam.root ?? undefined
    },
    heroic: {
      present: heroic.present,
      variant: heroic.variant,
      configDir: heroic.configDir,
      legendary: !!heroic.legendaryBin,
      gogdl: !!heroic.gogdlBin,
      nile: !!heroic.nileBin,
      detail: heroic.configDir ?? undefined
    }
  }
}
