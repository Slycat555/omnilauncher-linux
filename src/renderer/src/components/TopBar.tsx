import { useState } from 'react'
import { useAppStore } from '../store'
import { RefreshIcon, SearchIcon, TrashIcon, UsersIcon, XIcon } from './Icons'

interface Props {
  query: string
  onQuery: (q: string) => void
  onRefresh: () => Promise<void>
}

export function TopBar({ query, onQuery, onRefresh }: Props): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false)
  const manageMode = useAppStore((s) => s.manageMode)
  const selectedCount = useAppStore((s) => Object.keys(s.selectedForManage).length)
  const bulkUninstalling = useAppStore((s) => s.bulkUninstalling)
  const toggleManageMode = useAppStore((s) => s.toggleManageMode)
  const bulkUninstallSelected = useAppStore((s) => s.bulkUninstallSelected)

  return (
    <div className="topbar">
      {manageMode ? (
        <div className="manage-bar">
          <span className="manage-bar-label">
            {selectedCount === 0 ? 'Select installed games to uninstall' : `${selectedCount} selected`}
          </span>
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-danger-solid"
            disabled={selectedCount === 0 || bulkUninstalling}
            onClick={() => bulkUninstallSelected()}
          >
            <TrashIcon size={13} /> {bulkUninstalling ? 'Uninstalling…' : 'Uninstall selected'}
          </button>
          <button className="icon-btn" title="Exit manage mode" onClick={toggleManageMode}>
            <XIcon size={15} />
          </button>
        </div>
      ) : (
        <>
          <div className="search-box">
            <SearchIcon size={15} />
            <input
              placeholder="Search your library…"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" title="Select multiple games to uninstall" onClick={toggleManageMode}>
            <UsersIcon size={15} />
          </button>
          <button
            className={`icon-btn${refreshing ? ' spinning' : ''}`}
            title="Rescan Steam & Heroic libraries"
            onClick={async () => {
              setRefreshing(true)
              try {
                await onRefresh()
              } finally {
                setRefreshing(false)
              }
            }}
          >
            <RefreshIcon />
          </button>
        </>
      )}
    </div>
  )
}
