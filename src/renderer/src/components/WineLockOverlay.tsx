import { useAppStore } from '../store'

/** Covers the whole library while any Wine/Proton process is running, so a stray click,
 *  key or controller press meant for the game can never start an install/launch in the
 *  launcher behind it. The UI underneath is also made `inert` by App.tsx - this overlay
 *  is just what the user sees. The titlebar stays outside both, so the window can still
 *  be minimized or closed to the tray. */
export function WineLockOverlay(): React.JSX.Element | null {
  const { active, processes } = useAppStore((s) => s.wineActivity)
  if (!active) return null

  return (
    <div className="wine-lock-overlay" role="alertdialog" aria-live="polite">
      <div className="wine-lock-card">
        <div className="wine-lock-pulse" />
        <div className="wine-lock-label">Game running</div>
        <div className="wine-lock-title">
          {processes.length > 0 ? processes.join(', ') : 'Wine / Proton is running'}
        </div>
        <div className="wine-lock-hint">
          OmniLauncher is paused and will unlock automatically when it closes.
        </div>
      </div>
    </div>
  )
}
