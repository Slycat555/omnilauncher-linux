import { useEffect, useState } from 'react'
import type { UnifiedGame } from '../../../shared/types'
import {
  downloadEtaSeconds,
  downloadTotal,
  formatBytes,
  formatDuration,
  formatSpeed
} from '../format'
import type { DownloadEntry } from '../store'
import { useAppStore } from '../store'
import { CheckIcon, PlayIcon, StopIcon, XIcon } from './Icons'
import { NetworkGraph } from './NetworkGraph'

function statusText(d: DownloadEntry, game?: UnifiedGame): string {
  if (d.status === 'done') return 'Installed'
  if (d.status === 'cancelled') return 'Cancelled'
  if (d.status === 'error') return d.message ? `Failed: ${d.message.split('\n')[0]}` : 'Failed'
  if (d.phase === 'installing') return 'Installing'
  if (d.phase === 'downloading') return d.speedBps > 0 ? 'Downloading' : 'Preparing'
  // Steam won't start until the user confirms its own install dialog - say so, rather
  // than leaving this looking stuck at 0%.
  return game?.store === 'steam'
    ? "Waiting for Steam - confirm the install in Steam's dialog"
    : 'Preparing…'
}

/** Current time, re-read every second - for the live "Elapsed" figure. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

function ProgressBar({ percent }: { percent?: number }): React.JSX.Element {
  return (
    <div className={`dl-progress${percent === undefined ? ' indeterminate' : ''}`}>
      <div className="dl-progress-fill" style={{ width: `${percent ?? 0}%` }} />
    </div>
  )
}

/** The Downloads page: the current download big at the top (art, progress, speed,
 *  network graph), then anything else downloading, then finished ones - modelled on
 *  Steam's own Downloads page. Also embedded in Big Picture mode (`big`). */
export function DownloadsView({ big = false }: { big?: boolean }): React.JSX.Element {
  const downloads = useAppStore((s) => s.downloads)
  const games = useAppStore((s) => s.games)
  const covers = useAppStore((s) => s.covers)
  const loadCover = useAppStore((s) => s.loadCover)
  const cancelInstall = useAppStore((s) => s.cancelInstall)
  const launch = useAppStore((s) => s.launch)
  const clearFinishedDownloads = useAppStore((s) => s.clearFinishedDownloads)
  const now = useNow()

  // Queued installs aren't shown - only the one actually downloading is.
  // Only one install downloads at a time; the rest wait here in the order they were added.
  const queued = Object.values(downloads)
    .filter((d) => d.status === 'queued')
    .sort((a, b) => a.startedAt - b.startedAt)
  const all = Object.values(downloads).filter((d) => d.status !== 'queued')
  const active = all.filter((d) => d.status === 'active').sort((a, b) => a.startedAt - b.startedAt)
  const finished = all
    .filter((d) => d.status !== 'active')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  const current = active[0]
  const gameOf = (id: string): UnifiedGame | undefined => games.find((g) => g.id === id)

  const ids = [...all, ...queued].map((d) => d.gameId).join(',')
  useEffect(() => {
    for (const id of ids.split(',').filter(Boolean)) void loadCover(id)
  }, [ids, loadCover])

  if (all.length === 0 && queued.length === 0) {
    return (
      <div className={`downloads-page${big ? ' big' : ''}`}>
        <div className="downloads-empty">
          <div className="downloads-empty-title">No downloads</div>
          <div>Games you install show up here with their progress and download speed.</div>
        </div>
      </div>
    )
  }

  const currentGame = current && gameOf(current.gameId)
  const currentArt = current && (covers[current.gameId]?.hero ?? covers[current.gameId]?.cover)
  const currentTotal = current && downloadTotal(current, currentGame)

  return (
    <div className={`downloads-page${big ? ' big' : ''}`}>
      {current && (
        <section className="dl-current">
          {currentArt && (
            <div className="dl-current-bg" style={{ backgroundImage: `url("${currentArt}")` }} />
          )}
          <div className="dl-current-body">
            <div className="dl-current-head">
              {covers[current.gameId]?.cover ? (
                <img className="dl-current-cover" src={covers[current.gameId]!.cover!} alt="" />
              ) : (
                <div className="dl-current-cover empty" />
              )}
              <div className="dl-current-info">
                <div className="dl-eyebrow">{statusText(current, currentGame)}</div>
                <div className="dl-current-title">{currentGame?.title ?? current.gameId}</div>
                <ProgressBar percent={current.percent} />
                <div className="dl-current-progress-text">
                  <span>
                    {current.percent !== undefined ? `${current.percent.toFixed(1)}%` : '—'}
                  </span>
                  <span>
                    {formatBytes(current.downloadedBytes)}
                    {currentTotal
                      ? ` of ${current.totalBytes ? '' : '~'}${formatBytes(currentTotal)}`
                      : ''}
                  </span>
                </div>
              </div>
              {!big && (
                <button
                  className="btn btn-danger-solid"
                  onClick={() => cancelInstall(current.gameId)}
                >
                  <StopIcon size={13} /> Cancel
                </button>
              )}
            </div>

            <div className="dl-stats">
              <div className="dl-stat">
                <div className="dl-stat-label">Current</div>
                <div className="dl-stat-value accent">{formatSpeed(current.speedBps)}</div>
              </div>
              <div className="dl-stat">
                <div className="dl-stat-label">Peak</div>
                <div className="dl-stat-value">{formatSpeed(current.peakBps)}</div>
              </div>
              <div className="dl-stat">
                <div className="dl-stat-label">Time remaining</div>
                <div className="dl-stat-value">
                  {formatDuration(downloadEtaSeconds(current, currentGame))}
                </div>
              </div>
              <div className="dl-stat">
                <div className="dl-stat-label">Elapsed</div>
                <div className="dl-stat-value">
                  {formatDuration((now - current.startedAt) / 1000)}
                </div>
              </div>
            </div>

            <NetworkGraph samples={current.samples} peakBps={current.peakBps} />
          </div>
        </section>
      )}

      {queued.length > 0 && (
        <section className="dl-section">
          <div className="dl-section-title">Queue ({queued.length})</div>
          {queued.map((d, i) => {
            const game = gameOf(d.gameId)
            return (
              <div key={d.gameId} className="dl-row">
                {covers[d.gameId]?.cover ? (
                  <img className="dl-row-cover" src={covers[d.gameId]!.cover!} alt="" />
                ) : (
                  <div className="dl-row-cover empty" />
                )}
                <div className="dl-row-main">
                  <div className="dl-row-title">{game?.title ?? d.gameId}</div>
                  <div className="dl-row-sub">
                    {i === 0
                      ? 'Next - starts when the current download finishes'
                      : `#${i + 1} in queue`}
                  </div>
                </div>
                {!big && (
                  <button
                    className="icon-btn"
                    title="Remove from queue"
                    onClick={() => cancelInstall(d.gameId)}
                  >
                    <XIcon size={15} />
                  </button>
                )}
              </div>
            )
          })}
        </section>
      )}

      {finished.length > 0 && (
        <section className="dl-section">
          <div className="dl-section-title">
            Completed ({finished.length})
            {!big && (
              <button className="btn" onClick={clearFinishedDownloads}>
                Clear
              </button>
            )}
          </div>
          {finished.map((d) => {
            const game = gameOf(d.gameId)
            return (
              <div key={d.gameId} className={`dl-row finished ${d.status}`}>
                {covers[d.gameId]?.cover ? (
                  <img className="dl-row-cover" src={covers[d.gameId]!.cover!} alt="" />
                ) : (
                  <div className="dl-row-cover empty" />
                )}
                <div className="dl-row-main">
                  <div className="dl-row-title">{game?.title ?? d.gameId}</div>
                  <div className="dl-row-sub">
                    {d.status === 'done' && <CheckIcon size={12} />} {statusText(d, game)}
                    {d.downloadedBytes ? ` · ${formatBytes(d.downloadedBytes)}` : ''}
                    {d.finishedAt
                      ? ` · ${formatDuration((d.finishedAt - d.startedAt) / 1000)}`
                      : ''}
                  </div>
                </div>
                {!big && d.status === 'done' && game?.isInstalled && (
                  <button
                    className="round-btn round-btn-play"
                    title="Play"
                    disabled={!game.canLaunch}
                    onClick={() => launch(game.id)}
                  >
                    <PlayIcon size={14} />
                  </button>
                )}
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
