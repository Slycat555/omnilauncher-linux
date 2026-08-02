import { useEffect } from 'react'
import { useAppStore } from '../store'
import { XIcon } from './Icons'

export function Toast(): React.JSX.Element | null {
  const toast = useAppStore((s) => s.toast)
  const dismissToast = useAppStore((s) => s.dismissToast)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dismissToast, 8000)
    return () => clearTimeout(t)
  }, [toast, dismissToast])

  if (!toast) return null

  return (
    <div className="toast">
      <span>{toast}</span>
      <button className="icon-btn" onClick={dismissToast}>
        <XIcon size={14} />
      </button>
    </div>
  )
}
