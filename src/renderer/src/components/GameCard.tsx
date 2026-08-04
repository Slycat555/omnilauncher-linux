import { useEffect } from 'react'
import type { UnifiedGame } from '../../../shared/types'
import { useAppStore } from '../store'
import { CheckIcon, DownloadIcon, PlayIcon, StopIcon } from './Icons'

interface Props {
  game: UnifiedGame
  focused?: boolean
  onMouseEnter?: () => void
}

export function GameCard({ game, focused, onMouseEnter }: Props): React.JSX.Element {
  const cover = useAppStore((s) => s.covers[game.id])
  const loadCover = useAppStore((s) => s.loadCover)
  const install = useAppStore((s) => s.install)
  const cancelInstall = useAppStore((s) => s.cancelInstall)
  const launch = useAppStore((s) => s.launch)
  const manageMode = useAppStore((s) => s.manageMode)
  const selected = useAppStore((s) => !!s.selectedForManage[game.id])
  const toggleGameSelected = useAppStore((s) => s.toggleGameSelected)
  const openDetails = useAppStore((s) => s.openDetails)

  useEffect(() => {
    void loadCover(game.id)
  }, [game.id, loadCover])

  // Deliberately not falling back to game.coverUrl (a raw remote URL from the store's own
  // metadata): every cover is downloaded once to a local file and served from cover://
  // from then on. Briefly showing the remote image, then swapping to the local file the
  // instant it lands, is what caused the flash/overlap - so show the placeholder tile
  // instead until the real (local) art is ready.
  const coverUrl = cover?.cover

  function onCardClick(): void {
    if (manageMode && game.isInstalled) toggleGameSelected(game.id)
  }

  return (
    <div
      className={`game-card${focused ? ' focused' : ''}${manageMode ? ' manageable' : ''}${selected ? ' selected' : ''}`}
      data-game-id={game.id}
      onClick={onCardClick}
      onMouseEnter={onMouseEnter}
    >
      <div
        className="card-art"
        onContextMenu={(e) => {
          if (manageMode) return
          e.preventDefault()
          e.stopPropagation()
          openDetails(game.id)
        }}
      >
        {manageMode ? (
          game.isInstalled && (
            <div className={`select-check${selected ? ' checked' : ''}`}>
              {selected && <CheckIcon size={13} />}
            </div>
          )
        ) : game.isInstalling ? (
          <div className="art-progress-fill" />
        ) : null}

        {coverUrl ? (
          <img className="cover" src={coverUrl} alt={game.title} loading="lazy" />
        ) : (
          <div className="cover-fallback">
            <span>{game.title}</span>
          </div>
        )}
      </div>

      <div className="card-footer">
        <div className="card-footer-main">
          <div className="card-title">{game.title}</div>
          {game.isInstalling ? (
            <div className="card-subtext">Installing…</div>
          ) : (
            <div className="card-subtext">{game.isInstalled ? 'Installed' : 'Not installed'}</div>
          )}
        </div>

        {!manageMode &&
          (game.isInstalling ? (
            <button
              className="round-btn round-btn-stop"
              title="Cancel install"
              onClick={(e) => {
                e.stopPropagation()
                cancelInstall(game.id)
              }}
            >
              <StopIcon size={14} />
            </button>
          ) : game.isInstalled ? (
            <button
              className="round-btn round-btn-play"
              disabled={!game.canLaunch}
              title={game.canLaunch ? 'Play' : 'Running…'}
              onClick={(e) => {
                e.stopPropagation()
                launch(game.id)
              }}
            >
              <PlayIcon size={14} />
            </button>
          ) : (
            <button
              className="round-btn round-btn-install"
              disabled={!game.canInstall}
              title="Install"
              onClick={(e) => {
                e.stopPropagation()
                install(game.id)
              }}
            >
              <DownloadIcon size={14} />
            </button>
          ))}
      </div>
    </div>
  )
}
