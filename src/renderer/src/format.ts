import type { UnifiedGame } from '../../shared/types'
import type { DownloadEntry } from './store'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 1024-based with KB/MB/GB labels - the same convention Steam's own download page uses. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${UNITS[unit]}`
}

export function formatSpeed(bps: number | undefined): string {
  return `${formatBytes(bps ?? 0)}/s`
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

/** Total size of a download. Steam reports it exactly; the Heroic backends only report
 *  bytes downloaded plus a percentage, so the total is extrapolated from those, falling
 *  back to the store's advertised install size. */
export function downloadTotal(d: DownloadEntry, game?: UnifiedGame): number | undefined {
  if (d.totalBytes) return d.totalBytes
  if (d.downloadedBytes && d.percent && d.percent >= 1) return d.downloadedBytes / (d.percent / 100)
  return game?.installSizeBytes
}

/** Seconds remaining, from the average of the last 10 seconds of speed samples (a single
 *  sample jumps around too much); falls back to the backend's own printed ETA. */
export function downloadEtaSeconds(d: DownloadEntry, game?: UnifiedGame): number | undefined {
  const total = downloadTotal(d, game)
  const recent = d.samples.slice(-10)
  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0
  if (total && d.downloadedBytes !== undefined && avg > 0) {
    return Math.max(0, (total - d.downloadedBytes) / avg)
  }
  const printed = d.eta?.match(/^(\d+):(\d{2}):(\d{2})$/)
  if (printed) return Number(printed[1]) * 3600 + Number(printed[2]) * 60 + Number(printed[3])
  return undefined
}
