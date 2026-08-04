import { useEffect, useState } from 'react'
import { MaximizeIcon, MinimizeIcon, RestoreIcon, XIcon } from './Icons'

/** Custom window chrome, since the BrowserWindow is created with frame: false (see
 *  main/index.ts) - the OS/window manager draws no title bar or window buttons at all
 *  anymore, this replaces them, the same way Steam's own client does. The whole bar is
 *  a drag region (-webkit-app-region: drag in CSS) except the buttons themselves, which
 *  opt back out (no-drag) so they stay clickable. */
export function Titlebar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.isWindowMaximized().then(setMaximized)
    return window.api.onWindowMaximizedChanged(setMaximized)
  }, [])

  return (
    <div className="titlebar">
      <div
        className="titlebar-drag"
        onDoubleClick={() => void window.api.toggleMaximizeWindow()}
      />
      <div className="titlebar-buttons">
        <button
          className="titlebar-btn"
          title="Minimize"
          onClick={() => void window.api.minimizeWindow()}
        >
          <MinimizeIcon size={11} />
        </button>
        <button
          className="titlebar-btn"
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => void window.api.toggleMaximizeWindow()}
        >
          {maximized ? <RestoreIcon size={11} /> : <MaximizeIcon size={11} />}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          title="Close"
          onClick={() => void window.api.closeWindow()}
        >
          <XIcon size={11} />
        </button>
      </div>
    </div>
  )
}
