import { useEffect, useRef, useState } from 'react'
import type { CompatInfo, ControllerModeInfo, ControllerModeSetting } from '../../../shared/types'
import { useAppStore } from '../store'
import { useModalNav } from '../useModalNav'
import {
  DownloadIcon,
  GamepadIcon,
  ImageIcon,
  NfcIcon,
  SettingsIcon,
  StopIcon,
  TrashIcon,
  XIcon
} from './Icons'
import { followScrollBehavior } from '../scrollFollow'

interface Item {
  key: string
  run: () => void
  disabled?: boolean
}

/** A game's options panel - install/uninstall, Proton, artwork and NFC - opened with
 *  right-click on a card or Y on a controller. Every control is reachable with the D-pad:
 *  the highlight walks the items top to bottom, A activates, B closes. */
export function GameDetailsPanel(): React.JSX.Element | null {
  const gameId = useAppStore((s) => s.detailsGameId)
  const games = useAppStore((s) => s.games)
  const closeDetails = useAppStore((s) => s.closeDetails)
  const openCoverPicker = useAppStore((s) => s.openCoverPicker)
  const nfcAvailable = useAppStore((s) => s.nfcAvailable)
  const writeGameToTag = useAppStore((s) => s.writeGameToTag)
  const install = useAppStore((s) => s.install)
  const uninstall = useAppStore((s) => s.uninstall)
  const cancelInstall = useAppStore((s) => s.cancelInstall)
  const queued = useAppStore((s) => (gameId ? s.downloads[gameId]?.status === 'queued' : false))
  // Inline status for the write flow instead of a toast popup - 'idle' shows the normal
  // button, 'writing' shows the hold-a-tag prompt, 'written'/'error' show a result
  // message right in the panel until it's closed or a new write is started.
  const [writeStatus, setWriteStatus] = useState<'idle' | 'writing' | 'written' | 'error'>('idle')
  const [writeError, setWriteError] = useState<string | null>(null)
  // Uninstall asks for a second press - it deletes the game's files.
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [compat, setCompat] = useState<CompatInfo | null>(null)
  const [compatError, setCompatError] = useState<string | null>(null)
  // The Proton choice is a compact dropdown: one row until opened.
  const [protonOpen, setProtonOpen] = useState(false)
  // OmniLauncher's own controller layer - null for Steam games, which keep Steam Input.
  const [inputMode, setInputMode] = useState<ControllerModeInfo | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setWriteStatus('idle')
    setWriteError(null)
    setConfirmUninstall(false)
    setCompat(null)
    setCompatError(null)
    setProtonOpen(false)
    setInputMode(null)
    if (gameId) void window.api.getCompat(gameId).then(setCompat, () => setCompat(null))
    if (gameId) {
      void window.api.getControllerMode(gameId).then(setInputMode, () => setInputMode(null))
    }
  }, [gameId])

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

  async function chooseProton(toolId: string): Promise<void> {
    if (!gameId) return
    setCompatError(null)
    setProtonOpen(false)
    try {
      await window.api.setCompat(gameId, toolId)
      setCompat(await window.api.getCompat(gameId))
    } catch (err) {
      setCompatError(err instanceof Error ? err.message : String(err))
    }
  }

  async function toggleInputMode(): Promise<void> {
    if (!gameId || !inputMode) return
    // Two choices, like Steam's: Gamepad or Keyboard (WASD) and Mouse. A game nobody chose
    // for yet shows (and runs with) the one matching its controller support.
    const current = inputMode.setting === 'auto' ? inputMode.detected : inputMode.setting
    const next: ControllerModeSetting = current === 'gamepad' ? 'kbm' : 'gamepad'
    await window.api.setControllerMode(gameId, next)
    setInputMode({ ...inputMode, setting: next })
  }

  function installAction(): void {
    if (!game) return
    if (game.isInstalling) void cancelInstall(game.id)
    else if (!game.isInstalled) void install(game.id)
    else if (!confirmUninstall) setConfirmUninstall(true)
    else {
      setConfirmUninstall(false)
      void uninstall(game.id)
    }
  }

  // In display order - the controller highlight walks this list top to bottom.
  const items: Item[] = []
  if (game && (game.isInstalled || game.isInstalling || game.canInstall)) {
    items.push({
      key: 'install',
      run: installAction,
      disabled: game.isInstalled && !game.canUninstall
    })
  }
  if (compat?.supported) {
    items.push({ key: 'proton', run: () => setProtonOpen(true) })
  }
  if (inputMode) {
    items.push({ key: 'input', run: () => void toggleInputMode() })
  }
  items.push({
    key: 'cover',
    run: () => {
      if (!gameId) return
      closeDetails()
      void openCoverPicker(gameId)
    }
  })
  if (nfcAvailable) {
    items.push({
      key: 'nfc',
      run: () => void handleWriteTag(),
      disabled: writeStatus === 'writing'
    })
  }

  // While the dropdown is open the controller highlight walks its options only, and
  // B/Escape closes the dropdown rather than the whole panel.
  const navItems: Item[] =
    protonOpen && compat
      ? compat.options.map((opt) => ({
          key: `proton:${opt.id}`,
          run: () => void chooseProton(opt.id)
        }))
      : items
  const focusedIndex = useModalNav({
    enabled: !!gameId,
    count: navItems.length,
    columns: () => 1,
    onSelect: (i) => {
      const item = navItems[i]
      if (item && !item.disabled) item.run()
    },
    onClose: () => (protonOpen ? setProtonOpen(false) : closeDetails())
  })
  const focusedKey = navItems[focusedIndex]?.key

  useEffect(() => {
    bodyRef.current
      ?.querySelector('.focused')
      ?.scrollIntoView({ block: 'nearest', behavior: followScrollBehavior() })
  }, [focusedKey])

  if (!gameId) return null
  const isFocused = (key: string): string => (focusedKey === key ? ' focused' : '')

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

        <div className="details-panel-body" ref={bodyRef}>
          {game && items.some((i) => i.key === 'install') && (
            <div className="details-section-row">
              <div className="details-preview-tile details-preview-tile-empty">
                {game.isInstalled ? <TrashIcon size={22} /> : <DownloadIcon size={22} />}
              </div>
              <div className="details-section-main">
                <div className="details-section-header">
                  <span>{game.isInstalled ? 'Installed' : 'Not installed'}</span>
                </div>
                <p className="details-section-hint">
                  {game.isInstalling
                    ? queued
                      ? 'Waiting in the download queue.'
                      : 'Downloading - see the Downloads page for progress.'
                    : game.isInstalled
                      ? confirmUninstall
                        ? "This deletes the game's files. Press again to confirm."
                        : (game.installPath ?? '')
                      : game.installSizeBytes
                        ? `Install size: ${(game.installSizeBytes / 1024 ** 3).toFixed(1)} GB`
                        : 'Download and install this game.'}
                </p>
                <button
                  className={`btn ${game.isInstalled || game.isInstalling ? 'btn-danger-solid' : 'btn-install-blue'}${isFocused('install')}`}
                  disabled={game.isInstalled && !game.canUninstall}
                  onClick={installAction}
                >
                  {game.isInstalling ? (
                    <>
                      <StopIcon size={13} /> {queued ? 'Remove from queue' : 'Cancel install'}
                    </>
                  ) : game.isInstalled ? (
                    <>
                      <TrashIcon size={13} /> {confirmUninstall ? 'Confirm uninstall' : 'Uninstall'}
                    </>
                  ) : (
                    <>
                      <DownloadIcon size={13} /> Install
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {compat?.supported && (
            <div className="details-section-row">
              <div className="details-preview-tile details-preview-tile-empty">
                <SettingsIcon size={22} />
              </div>
              <div className="details-section-main">
                <div className="details-section-header">
                  <span>Proton</span>
                </div>
                <p className="details-section-hint">
                  {compatError ?? 'Which Proton version runs this game.'}
                </p>
                <button
                  className={`proton-select${protonOpen ? ' open' : ''}${isFocused('proton')}`}
                  aria-haspopup="listbox"
                  aria-expanded={protonOpen}
                  onClick={() => setProtonOpen((o) => !o)}
                >
                  <span className="proton-select-value">
                    {compat.options.find((o) => o.id === compat.current)?.label ?? compat.current}
                  </span>
                  <span className="proton-select-arrow">▾</span>
                </button>
                {protonOpen && (
                  <div className="proton-options" role="listbox">
                    {compat.options.map((opt) => (
                      <button
                        key={opt.id || 'default'}
                        role="option"
                        aria-selected={compat.current === opt.id}
                        className={`proton-option${compat.current === opt.id ? ' selected' : ''}${isFocused(`proton:${opt.id}`)}`}
                        onClick={() => void chooseProton(opt.id)}
                      >
                        <span className="proton-radio" />
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {inputMode && (
            <div className="details-section-row">
              <div className="details-preview-tile details-preview-tile-empty">
                <GamepadIcon size={22} />
              </div>
              <div className="details-section-main">
                <div className="details-section-header">
                  <span>Controller</span>
                </div>
                <p className="details-section-hint">
                  {(inputMode.setting === 'auto' ? inputMode.detected : inputMode.setting) ===
                  'gamepad'
                    ? "Steam Input's Gamepad layout - the game sees an Xbox controller."
                    : "Steam Input's Keyboard (WASD) and Mouse layout - for games without controller support."}
                </p>
                <button
                  className={`proton-select${isFocused('input')}`}
                  onClick={() => void toggleInputMode()}
                >
                  <span className="proton-select-value">
                    {(inputMode.setting === 'auto' ? inputMode.detected : inputMode.setting) ===
                    'gamepad'
                      ? 'Gamepad'
                      : 'Keyboard (WASD) and Mouse'}
                  </span>
                  <span className="proton-select-arrow">⇄</span>
                </button>
              </div>
            </div>
          )}

          <div className="details-section-row">
            <div className="details-preview-tile details-preview-tile-empty">
              <ImageIcon size={22} />
            </div>
            <div className="details-section-main">
              <div className="details-section-header">
                <span>Artwork</span>
              </div>
              <p className="details-section-hint">Pick cover art for this game from SteamGridDB.</p>
              <button
                className={`btn btn-install-blue${isFocused('cover')}`}
                onClick={() => items.find((i) => i.key === 'cover')?.run()}
              >
                Choose cover art
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
                    className={`btn btn-install-blue${isFocused('nfc')}`}
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
        <div className="modal-hints">
          <span>
            <kbd>A</kbd> Select
          </span>
          <span>
            <kbd>B</kbd> Close
          </span>
        </div>
      </div>
    </div>
  )
}
