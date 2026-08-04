import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { AppSettings, SettingsPatch } from '../shared/types'
import { appConfigDir, settingsFilePath } from './paths'

const DEFAULTS: AppSettings = {
  steamGridDbApiKey: '',
  steamWebApiKey: '',
  steamId64: '',
  enabledStores: { epic: false, amazon: false },
  uiScale: 1
}

let cached: AppSettings | null = null

function ensureConfigDir(): void {
  const dir = appConfigDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function loadSettings(): AppSettings {
  if (cached) return cached
  ensureConfigDir()
  const file = settingsFilePath()
  if (!existsSync(file)) {
    cached = { ...DEFAULTS }
    persist(cached)
    return cached
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    cached = { ...DEFAULTS, ...raw }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached as AppSettings
}

export function saveSettings(patch: SettingsPatch): AppSettings {
  const current = loadSettings()
  cached = { ...current, ...patch }
  persist(cached)
  return cached
}

function persist(settings: AppSettings): void {
  ensureConfigDir()
  writeFileSync(settingsFilePath(), JSON.stringify(settings, null, 2), { mode: 0o600 })
}
