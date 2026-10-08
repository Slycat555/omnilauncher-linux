import type { AppSettings, StoreKind, UnifiedGame } from '../../../shared/types'
import { formatSpeed } from '../format'
import type { StoreFilter } from '../store'
import { useAppStore } from '../store'
import { DownloadIcon, GridIcon, SettingsIcon } from './Icons'

export type View = 'library' | 'settings' | 'downloads'

interface Props {
  games: UnifiedGame[]
  settings: AppSettings | null
  storeFilter: StoreFilter
  onStoreFilter: (f: StoreFilter) => void
  installedOnly: boolean
  onToggleInstalledOnly: () => void
  view: View
  onView: (v: View) => void
}

const ALL_STORES: { key: StoreKind; label: string }[] = [
  { key: 'steam', label: 'Steam' },
  { key: 'gog', label: 'GOG' },
  { key: 'epic', label: 'Epic Games' },
  { key: 'amazon', label: 'Amazon' }
]

export function Sidebar({
  games,
  settings,
  storeFilter,
  onStoreFilter,
  installedOnly,
  onToggleInstalledOnly,
  view,
  onView
}: Props): React.JSX.Element {
  const countFor = (f: StoreFilter): number =>
    f === 'all' ? games.length : games.filter((g) => g.store === f).length
  const installedCount = games.filter((g) => g.isInstalled).length
  const activeDownloads = useAppStore((s) =>
    Object.values(s.downloads).filter((d) => d.status === 'active')
  )
  const totalSpeed = activeDownloads.reduce((sum, d) => sum + d.speedBps, 0)
  const known = activeDownloads.filter((d) => d.percent !== undefined)
  const overallPercent = known.length
    ? known.reduce((sum, d) => sum + (d.percent ?? 0), 0) / known.length
    : undefined

  const visibleStores = ALL_STORES.filter((s) => {
    if (s.key === 'epic') return settings?.enabledStores.epic ?? false
    if (s.key === 'amazon') return settings?.enabledStores.amazon ?? false
    return true
  })

  return (
    <div className="sidebar">
      <div className="brand">
        <span className="dot" />
        OmniLauncher
      </div>

      <div className="nav-group">
        <div className="nav-group-label">Library</div>
        <button
          className={`nav-item${view === 'library' && storeFilter === 'all' && !installedOnly ? ' active' : ''}`}
          onClick={() => {
            onView('library')
            onStoreFilter('all')
          }}
        >
          <span className="nav-item-label">
            <GridIcon size={14} />
            All games
          </span>
          <span className="count">{countFor('all')}</span>
        </button>
        <button
          className={`nav-item${view === 'library' && installedOnly ? ' active' : ''}`}
          onClick={() => {
            onView('library')
            onToggleInstalledOnly()
          }}
        >
          <span>Installed</span>
          <span className="count">{installedCount}</span>
        </button>
        {visibleStores.map((s) => (
          <button
            key={s.key}
            className={`nav-item${view === 'library' && storeFilter === s.key ? ' active' : ''}`}
            onClick={() => {
              onView('library')
              onStoreFilter(s.key)
            }}
          >
            <span>{s.label}</span>
            <span className="count">{countFor(s.key)}</span>
          </button>
        ))}
      </div>

      <div className="nav-group">
        <button
          className={`nav-item${view === 'downloads' ? ' active' : ''}`}
          onClick={() => onView('downloads')}
        >
          <span className="nav-item-label">
            <DownloadIcon size={14} />
            Downloads
          </span>
          {activeDownloads.length > 0 && (
            <span className="count accent">{activeDownloads.length}</span>
          )}
        </button>
      </div>

      <div className="sidebar-footer">
        {activeDownloads.length > 0 && (
          <button className="sidebar-download-status" onClick={() => onView('downloads')}>
            <div className="sidebar-download-text">
              <span>
                Downloading ({activeDownloads.length})
              </span>
              <span>{formatSpeed(totalSpeed)}</span>
            </div>
            <div
              className={`dl-progress small${overallPercent === undefined ? ' indeterminate' : ''}`}
            >
              <div className="dl-progress-fill" style={{ width: `${overallPercent ?? 0}%` }} />
            </div>
          </button>
        )}
        <button
          className={`nav-item${view === 'settings' ? ' active' : ''}`}
          onClick={() => onView('settings')}
        >
          <span className="nav-item-label">
            <SettingsIcon size={14} />
            Settings
          </span>
        </button>
      </div>
    </div>
  )
}
