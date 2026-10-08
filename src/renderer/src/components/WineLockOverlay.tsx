import { useAppStore } from '../store'

/** Covers the whole library while a game is running, so a stray click,
 *  key or controller press meant for the game can never start an install/launch in the
 *  launcher behind it. The UI underneath is also made `inert` by App.tsx - this overlay
 *  is just what the user sees. The titlebar stays outside both, so the window can still
 *  be minimized or closed to the tray. */
export function WineLockOverlay(): React.JSX.Element | null {
  const { active, gameIds } = useAppStore((s) => s.wineActivity)
  const games = useAppStore((s) => s.games)
  const covers = useAppStore((s) => s.covers)
  if (!active) return null
  // The same cover art the library card shows, so it looks like part of the app.
  const art = gameIds.map((id) => covers[id]?.cover).find((c): c is string => !!c)
  // Always the game's library title - never a process or file name.
  const titles = gameIds
    .map((id) => games.find((g) => g.id === id)?.title)
    .filter((t): t is string => !!t)

  return (
    <div className="wine-lock-overlay" role="alertdialog" aria-live="polite">
      <div className="wine-lock-card">
        {art ? (
          <img className="wine-lock-art" src={art} alt="" decoding="sync" />
        ) : (
          <div className="wine-lock-art empty" />
        )}
        <div className="wine-lock-label">Game running</div>
        <div className="wine-lock-title">
          {titles.length > 0 ? titles.join(', ') : 'A game is running'}
        </div>
        <div className="wine-lock-hint">
          OmniLauncher is paused and will unlock automatically when it closes.
        </div>
      </div>
    </div>
  )
}
