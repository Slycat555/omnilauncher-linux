import { useEffect, useState } from 'react'
import { keyNavAction } from './keyNav'
import { useGamepadNav } from './useGamepadNav'

interface Options {
  /** Only the topmost open modal should be enabled at a time. */
  enabled: boolean
  count: number
  /** Items per row - 1 for a vertical list. A function so a responsive grid can be
   *  measured at the moment of the key press rather than guessed up front. */
  columns: () => number
  onSelect: (index: number) => void
  onClose: () => void
}

/** Controller + keyboard navigation inside a modal (GameDetailsPanel, CoverPicker): the
 *  D-pad/arrows move a highlight, A/Enter activates it, B/Escape closes. These modals
 *  were mouse-only before, so a controller user had no way to pick cover art at all. */
export function useModalNav({ enabled, count, columns, onSelect, onClose }: Options): number {
  const [index, setIndex] = useState(0)

  // A freshly opened modal (or a new set of options loading in) starts at the top -
  // adjusted during render rather than in an effect, so there's no frame where the old
  // highlight shows on the new contents.
  const resetKey = `${enabled}:${count}`
  const [prevResetKey, setPrevResetKey] = useState(resetKey)
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey)
    setIndex(0)
  }

  function move(dir: 'up' | 'down' | 'left' | 'right'): void {
    if (count === 0) return
    const cols = Math.max(1, columns())
    setIndex((i) => {
      let next = i
      if (dir === 'right') next = i + 1
      if (dir === 'left') next = i - 1
      if (dir === 'down') next = i + cols
      if (dir === 'up') next = i - cols
      return Math.min(count - 1, Math.max(0, next))
    })
  }

  useGamepadNav({
    enabled,
    onDirection: move,
    onConfirm: () => count > 0 && onSelect(index),
    onBack: onClose,
    onTabLeft: () => {},
    onTabRight: () => {}
  })

  useEffect(() => {
    if (!enabled) return
    function onKey(e: KeyboardEvent): void {
      const action = keyNavAction(e)
      if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
        move(action)
      } else if (action === 'confirm' && count > 0) onSelect(index)
      else if (action === 'back') onClose()
      // Anything else (tabs, Start...) is swallowed too - it must not act on the view
      // behind the modal.
      else if (!action) return
      // Captured and stopped here so the library's own window-level key handler behind
      // the modal doesn't also move its focus or launch the focused game.
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, count, index])

  return index
}
