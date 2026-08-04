import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { ImageIcon, NfcIcon, XIcon } from './Icons'

/** Artwork + NFC management for one game, as its own dedicated panel - not a
 *  right-click/context menu or a "⋮" dropdown. Opened via right-click on a GameCard's
 *  art, closed via the X or by clicking the overlay, same pattern as CoverPicker.
 *
 *  Deliberately does NOT show the game's actual cover image here, only the plain
 *  ImageIcon symbol - this panel is a launcher for the cover-art picker, not a preview
 *  of the current art, so there's no fetch to wait on or pop-in to see. */
export function GameDetailsPanel(): React.JSX.Element | null {
  const gameId = useAppStore((s) => s.detailsGameId)
  const games = useAppStore((s) => s.games)
  const closeDetails = useAppStore((s) => s.closeDetails)
  const openCoverPicker = useAppStore((s) => s.openCoverPicker)
  const nfcAvailable = useAppStore((s) => s.nfcAvailable)
  const writeGameToTag = useAppStore((s) => s.writeGameToTag)
  // Inline status for the write flow instead of a toast popup - 'idle' shows the normal
  // button, 'writing' shows the hold-a-tag prompt, 'written'/'error' show a result
  // message right in the panel until it's closed or a new write is started.
  const [writeStatus, setWriteStatus] = useState<'idle' | 'writing' | 'written' | 'error'>(
    'idle'
  )
  const [writeError, setWriteError] = useState<string | null>(null)

  useEffect(() => {
    setWriteStatus('idle')
    setWriteError(null)
  }, [gameId])

  if (!gameId) return null
  const game = games.find((g) => g.id === gameId)

  async function handleWriteTag(): Promise<void> {
    if (!gameId) return
    setWriteStatus('writing')
    try {
      await writeGameToTag(gameId)
      setWriteStatus('written')
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err))
      setWriteStatus('error')
    }
  }

  return (
    <div className="details-panel-overlay" onClick={closeDetails}>
      <div className="details-panel" onClick={(e) => e.stopPropagation()}>
        <div className="details-panel-header">
          <div>
            <div className="details-panel-title">Game settings</div>
            {game && <div className="details-panel-subtitle">{game.title}</div>}
          </div>
          <button className="icon-btn" onClick={closeDetails}>
            <XIcon size={16} />
          </button>
        </div>

        <div className="details-panel-body">
          <div className="details-section-row">
            <div className="details-preview-tile details-preview-tile-empty">
              <ImageIcon size={22} />
            </div>
            <div className="details-section-main">
              <div className="details-section-header">
                <span>Artwork</span>
              </div>
              <p className="details-section-hint">
                Pick cover art for this game from SteamGridDB.
              </p>
              <button
                className="btn btn-install-blue"
                onClick={() => {
                  closeDetails()
                  void openCoverPicker(gameId)
                }}
              >
                Choose cover art…
              </button>
            </div>
          </div>

          <div className="details-section-row">
            <div className="details-preview-tile details-preview-tile-empty">
              <NfcIcon size={22} />
            </div>
            <div className="details-section-main">
              <div className="details-section-header">
                <span>NFC tag</span>
              </div>
              {nfcAvailable ? (
                <>
                  <p className="details-section-hint">
                    {writeStatus === 'written'
                      ? 'Tag written.'
                      : writeStatus === 'error'
                        ? writeError
                        : 'Write this game to a tag - tap it later to launch instantly.'}
                  </p>
                  <button
                    className="btn btn-install-blue"
                    disabled={writeStatus === 'writing'}
                    onClick={handleWriteTag}
                  >
                    {writeStatus === 'writing' ? 'Hold a tag to the reader…' : 'Write NFC tag'}
                  </button>
                </>
              ) : (
                <p className="details-section-hint">No NFC reader detected.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
