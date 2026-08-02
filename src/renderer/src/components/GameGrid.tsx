import type { UnifiedGame } from '../../../shared/types'
import { GameCard } from './GameCard'

interface Props {
  games: UnifiedGame[]
  focusedId: string | null
}

export function GameGrid({ games, focusedId }: Props): React.JSX.Element {
  if (games.length === 0) {
    return (
      <div className="empty-state">
        <div style={{ fontSize: 15 }}>No games match your filters</div>
        <div style={{ fontSize: 12 }}>
          Try clearing the search box or switching store/installed filters.
        </div>
      </div>
    )
  }

  return (
    <div className="game-grid">
      {games.map((g) => (
        <GameCard key={g.id} game={g} focused={g.id === focusedId} />
      ))}
    </div>
  )
}
