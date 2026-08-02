import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { appConfigDir, playtimeFilePath } from './paths'

interface PlaytimeEntry {
  minutes: number
  lastPlayed: number
}

type PlaytimeStore = Record<string, PlaytimeEntry>

function load(): PlaytimeStore {
  const file = playtimeFilePath()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as PlaytimeStore
  } catch {
    return {}
  }
}

function save(store: PlaytimeStore): void {
  const dir = appConfigDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(playtimeFilePath(), JSON.stringify(store, null, 2))
}

export function getPlaytime(gameId: string): PlaytimeEntry | undefined {
  return load()[gameId]
}

export function getAllPlaytime(): PlaytimeStore {
  return load()
}

export function addPlaySession(gameId: string, minutes: number): void {
  if (minutes <= 0) return
  const store = load()
  const existing = store[gameId] ?? { minutes: 0, lastPlayed: 0 }
  store[gameId] = {
    minutes: existing.minutes + minutes,
    lastPlayed: Math.floor(Date.now() / 1000)
  }
  save(store)
}
