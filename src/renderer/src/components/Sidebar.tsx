import type { AppSettings, StoreKind, UnifiedGame } from '../../../shared/types'
import type { StoreFilter } from '../store'
import { GridIcon, SettingsIcon } from './Icons'

interface Props {
  games: UnifiedGame[]
  settings: AppSettings | null
  storeFilter: StoreFilter
  onStoreFilter: (f: StoreFilter) => void
  installedOnly: boolean
  onToggleInstalledOnly: () => void
  view: 'library' | 'settings'
  onView: (v: 'library' | 'settings') => void
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
          <span>
            <GridIcon size={14} /> &nbsp;All games
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

      <div className="sidebar-footer">
        <button
          className={`nav-item${view === 'settings' ? ' active' : ''}`}
          onClick={() => onView('settings')}
        >
          <span>
            <SettingsIcon size={14} /> &nbsp;Settings
          </span>
        </button>
      </div>
    </div>
  )
}
