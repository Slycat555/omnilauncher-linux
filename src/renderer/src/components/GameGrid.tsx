import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UnifiedGame } from '../../../shared/types'
import { GameCard } from './GameCard'

interface Props {
  games: UnifiedGame[]
  focusedId: string | null
  onHoverIndex?: (index: number) => void
  /** The actual scrolling ancestor (App's .main) - virtualization needs to know its
   *  scrollTop/clientHeight, not the grid's own (the grid is exactly as tall as its
   *  content, it doesn't scroll itself). */
  scrollContainer: HTMLElement | null
  /** Measured by App (shared with its own scroll-follow-focus math, see App.tsx) so
   *  both agree on exactly the same row height instead of each measuring independently
   *  and risking drift. 0 before the first real card has ever been measured. */
  rowHeight: number
}

const CARD_MIN_WIDTH = 160
const CARD_GAP = 16
// Rows rendered above/below the visible band, so a fast scroll or focus jump never
// shows a flash of missing cards before the next window catches up.
const OVERSCAN_ROWS = 3

/**
 * Only mounts GameCard rows near the visible viewport instead of the whole library at
 * once - a large "All games" list (300+ titles) mounted every single card
 * simultaneously with nothing windowing them, so a fast scroll forced the browser to
 * keep laying out and painting far more DOM than was ever visible, which is what
 * produced the lag.
 */
export function GameGrid({
  games,
  focusedId,
  onHoverIndex,
  scrollContainer,
  rowHeight
}: Props): React.JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(1)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const recompute = (): void => {
      setColumns(Math.max(1, Math.floor(grid.clientWidth / (CARD_MIN_WIDTH + CARD_GAP))))
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(grid)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = scrollContainer
    if (!el) return
    const onScroll = (): void => setScrollTop(el.scrollTop)
    const onResize = (): void => setViewportHeight(el.clientHeight)
    onScroll()
    onResize()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onResize)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [scrollContainer])

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

  const totalRows = Math.ceil(games.length / columns)
  // rowHeight starts at 0 before the first measurement lands - render everything for
  // that one frame rather than guessing a height and risking every card being wrongly
  // windowed out on first paint.
  const firstVisibleRow =
    rowHeight > 0 ? Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS) : 0
  const lastVisibleRow =
    rowHeight > 0
      ? Math.min(
          totalRows - 1,
          Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS
        )
      : totalRows - 1

  const startIndex = firstVisibleRow * columns
  const endIndex = Math.min(games.length, (lastVisibleRow + 1) * columns)
  const topSpacerHeight = firstVisibleRow * rowHeight
  const bottomSpacerHeight = (totalRows - 1 - lastVisibleRow) * rowHeight

  return (
    <div className="game-grid" ref={gridRef}>
      {topSpacerHeight > 0 && <div style={{ gridColumn: '1 / -1', height: topSpacerHeight }} />}
      {games.slice(startIndex, endIndex).map((g, i) => {
        const index = startIndex + i
        return (
          <GameCard
            key={g.id}
            game={g}
            focused={g.id === focusedId}
            onMouseEnter={onHoverIndex ? () => onHoverIndex(index) : undefined}
          />
        )
      })}
      {bottomSpacerHeight > 0 && (
        <div style={{ gridColumn: '1 / -1', height: bottomSpacerHeight }} />
      )}
    </div>
  )
}
