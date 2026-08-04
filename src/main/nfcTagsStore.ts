import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { appConfigDir, nfcTagsFilePath } from './paths'

/** Persisted uid -> gameId mapping for written tags, so a scan can resolve to a game
 *  from a local record instead of depending solely on re-reading and re-decoding the
 *  tag's own NDEF text every time (and instead of the mapping only ever existing on the
 *  physical tag itself, with no way for the app to show or manage what's been written).
 *  Keyed by the tag's hardware UID, not its NDEF content, since the UID is what's read
 *  off the tag before any NDEF decode happens at all. */
export interface NfcTagRecord {
  gameId: string
  writtenAt: string
}

type TagsFile = Record<string, NfcTagRecord>

let cached: TagsFile | null = null

function ensureConfigDir(): void {
  const dir = appConfigDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function load(): TagsFile {
  if (cached) return cached
  ensureConfigDir()
  const file = nfcTagsFilePath()
  if (!existsSync(file)) {
    cached = {}
    return cached
  }
  try {
    cached = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    cached = {}
  }
  return cached as TagsFile
}

function persist(): void {
  ensureConfigDir()
  writeFileSync(nfcTagsFilePath(), JSON.stringify(cached ?? {}, null, 2), { mode: 0o600 })
}

export function getGameIdForTag(uid: string): string | null {
  return load()[uid]?.gameId ?? null
}

export function recordTagWrite(uid: string, gameId: string): void {
  const tags = load()
  tags[uid] = { gameId, writtenAt: new Date().toISOString() }
  persist()
}

export function listTags(): Record<string, NfcTagRecord> {
  return { ...load() }
}

export function forgetTag(uid: string): void {
  const tags = load()
  if (!(uid in tags)) return
  delete tags[uid]
  persist()
}
