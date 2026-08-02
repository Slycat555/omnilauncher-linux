import { useAppStore } from '../store'
import { XIcon } from './Icons'

export function CoverPicker(): React.JSX.Element | null {
  const gameId = useAppStore((s) => s.coverPickerGameId)
  const options = useAppStore((s) => s.coverPickerOptions)
  const loading = useAppStore((s) => s.coverPickerLoading)
  const games = useAppStore((s) => s.games)
  const closeCoverPicker = useAppStore((s) => s.closeCoverPicker)
  const chooseCover = useAppStore((s) => s.chooseCover)

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
          <div className="cover-picker-grid">
            {options.map((opt) => (
              <button
                key={opt.id}
                className="cover-picker-option"
                onClick={() => chooseCover(gameId, opt.url)}
              >
                <img src={opt.thumb} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
