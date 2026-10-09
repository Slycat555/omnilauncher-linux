import { useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { useModalNav } from '../useModalNav'
import { XIcon } from './Icons'
import { followScrollBehavior } from '../scrollFollow'

/** Counts how many options share the first row - the grid is responsive
 *  (auto-fill), so the column count depends on the window width. */
function gridColumns(grid: HTMLElement | null): number {
  const items = grid ? Array.from(grid.children) : []
  if (items.length === 0) return 1
  const top = (items[0] as HTMLElement).offsetTop
  return items.filter((el) => (el as HTMLElement).offsetTop === top).length
}

export function CoverPicker(): React.JSX.Element | null {
  const gameId = useAppStore((s) => s.coverPickerGameId)
  const options = useAppStore((s) => s.coverPickerOptions)
  const loading = useAppStore((s) => s.coverPickerLoading)
  const games = useAppStore((s) => s.games)
  const closeCoverPicker = useAppStore((s) => s.closeCoverPicker)
  const chooseCover = useAppStore((s) => s.chooseCover)
  const gridRef = useRef<HTMLDivElement>(null)

  const focusedIndex = useModalNav({
    enabled: !!gameId,
    count: loading ? 0 : options.length,
    columns: () => gridColumns(gridRef.current),
    onSelect: (i) => gameId && options[i] && void chooseCover(gameId, options[i].url),
    onClose: closeCoverPicker
  })

  useEffect(() => {
    const el = gridRef.current?.children[focusedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest', behavior: followScrollBehavior() })
  }, [focusedIndex])

  if (!gameId) return null
  const game = games.find((g) => g.id === gameId)

  return (
    <div className="cover-picker-overlay" onClick={closeCoverPicker}>
      <div className="cover-picker" onClick={(e) => e.stopPropagation()}>
        <div className="cover-picker-header">
          <div>
            <div className="cover-picker-title">Choose cover art</div>
            {game && <div className="cover-picker-subtitle">{game.title}</div>}
          </div>
          <button className="icon-btn" onClick={closeCoverPicker}>
            <XIcon size={16} />
          </button>
        </div>

        {loading ? (
          <div className="empty-state" style={{ height: 200 }}>
            Searching SteamGridDB…
          </div>
        ) : options.length === 0 ? (
          <div className="empty-state" style={{ height: 200 }}>
            <div>No cover art found.</div>
            <div style={{ fontSize: 12 }}>Check your SteamGridDB API key in Settings.</div>
          </div>
        ) : (
          <div className="cover-picker-grid" ref={gridRef}>
            {options.map((opt, i) => (
              <button
                key={opt.id}
                className={`cover-picker-option${i === focusedIndex ? ' focused' : ''}`}
                onClick={() => chooseCover(gameId, opt.url)}
              >
                <img src={opt.thumb} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}
        <div className="modal-hints">
          <span>
            <kbd>A</kbd> Choose
          </span>
          <span>
            <kbd>B</kbd> Close
          </span>
        </div>
      </div>
    </div>
  )
}
