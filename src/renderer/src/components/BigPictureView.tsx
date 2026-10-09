import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, UnifiedGame } from '../../../shared/types'
import { formatBytes } from '../format'
import { useAppStore } from '../store'
import { keyNavAction, typingInField } from '../keyNav'
import { useGamepadNav } from '../useGamepadNav'
import { DownloadsView } from './DownloadsView'
import { DownloadIcon, PlayIcon, SettingsIcon, StopIcon } from './Icons'

interface Tab {
  key: string
  label: string
  /** Absent for the Downloads tab, which isn't a game grid. */
  filter?: (g: UnifiedGame) => boolean
}

interface Props {
  /** Already filtered for enabled stores / login state and sorted, same as the grid. */
  games: UnifiedGame[]
  settings: AppSettings | null
  /** Disables all input while the Wine/Proton lock or a modal is up. */
  inputEnabled: boolean
}

type Dir = 'up' | 'down' | 'left' | 'right'

/** Last real pointer position. Chromium fires mouse events on whatever ends up under a
 *  *stationary* cursor whenever content scrolls beneath it - which is exactly what D-pad
 *  navigation does - so a cursor resting over the window kept yanking focus back to the
 *  capsule under it. Only a pointer that actually moved may take focus. */
let lastPointer = { x: -1, y: -1 }
function pointerMoved(e: React.MouseEvent): boolean {
  if (e.screenX === lastPointer.x && e.screenY === lastPointer.y) return false
  lastPointer = { x: e.screenX, y: e.screenY }
  return true
}

function storeLabel(store: UnifiedGame['store']): string {
  return { steam: 'Steam', gog: 'GOG', epic: 'Epic Games', amazon: 'Amazon' }[store]
}

function formatPlaytime(minutes?: number): string {
  if (!minutes) return 'Never played'
  if (minutes < 60) return `${minutes} minutes`
  const hours = minutes / 60
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`
}

function formatLastPlayed(unixSeconds?: number): string {
  if (!unixSeconds) return 'Never'
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function Clock(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="bp-clock">
      {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </span>
  )
}

function Capsule({
  game,
  focused,
  onFocus,
  onActivate
}: {
  game: UnifiedGame
  focused: boolean
  onFocus: () => void
  onActivate: () => void
}): React.JSX.Element {
  const cover = useAppStore((s) => s.covers[game.id]?.cover)
  const loadCover = useAppStore((s) => s.loadCover)
  const percent = useAppStore((s) => s.downloads[game.id]?.percent)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void loadCover(game.id)
  }, [game.id, loadCover])

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: 'instant', block: 'nearest' })
  }, [focused])

  return (
    <button
      ref={ref}
      className={`bp-capsule${focused ? ' focused' : ''}`}
      onMouseMove={(e) => pointerMoved(e) && !focused && onFocus()}
      // First click focuses (like moving the D-pad onto it), a click on the already
      // focused capsule opens it - so a stray click never launches/installs anything.
      onClick={() => (focused ? onActivate() : onFocus())}
    >
      {cover ? (
        <img src={cover} alt="" decoding="sync" />
      ) : (
        <div className="bp-capsule-fallback">{game.title}</div>
      )}
      {game.isInstalling && (
        <div className="bp-capsule-progress">
          <div style={{ width: `${percent ?? 0}%` }} />
        </div>
      )}
    </button>
  )
}

/** Steam-style game page: full-width hero, big Play/Install button, stats - opened with
 *  A from the library grid, closed with B, like Steam Big Picture's own game pages. */
function GamePage({
  game,
  focusIndex
}: {
  game: UnifiedGame
  focusIndex: number
}): React.JSX.Element {
  const covers = useAppStore((s) => s.covers)
  const percent = useAppStore((s) => s.downloads[game.id]?.percent)
  const primaryAction = useAppStore((s) => s.primaryAction)
  const openDetails = useAppStore((s) => s.openDetails)
  const hero = covers[game.id]?.hero
  const cover = covers[game.id]?.cover

  const primary = game.isInstalling
    ? {
        cls: 'stop',
        icon: <StopIcon size={22} />,
        label: `Cancel install${percent !== undefined ? ` · ${percent.toFixed(0)}%` : ''}`
      }
    : game.isInstalled
      ? { cls: 'play', icon: <PlayIcon size={22} />, label: game.canLaunch ? 'Play' : 'Running' }
      : { cls: 'install', icon: <DownloadIcon size={22} />, label: 'Install' }

  return (
    <div className="bp-gamepage">
      <div className="bp-gamepage-hero">
        {hero ? (
          <img className="bp-gamepage-hero-img" src={hero} alt="" />
        ) : cover ? (
          <img className="bp-gamepage-poster" src={cover} alt="" />
        ) : null}
      </div>
      <h1 className="bp-gamepage-title">{game.title}</h1>

      <div className="bp-gamepage-bar">
        <button
          className={`bp-play ${primary.cls}${focusIndex === 0 ? ' focused' : ''}`}
          disabled={game.isInstalled && !game.canLaunch}
          onClick={() => primaryAction(game.id)}
        >
          {primary.icon}
          {primary.label}
        </button>
        <button
          className={`bp-iconbtn${focusIndex === 1 ? ' focused' : ''}`}
          title="Options & artwork"
          onClick={() => openDetails(game.id)}
        >
          <SettingsIcon size={22} />
        </button>

        <div className="bp-gamepage-stats">
          {game.isInstalled ? (
            <>
              <div>
                <div className="bp-stat-label">Last played</div>
                <div className="bp-stat-value">{formatLastPlayed(game.lastPlayed)}</div>
              </div>
              <div>
                <div className="bp-stat-label">Play time</div>
                <div className="bp-stat-value">{formatPlaytime(game.playtimeMinutes)}</div>
              </div>
            </>
          ) : (
            <div>
              <div className="bp-stat-label">Install size</div>
              <div className="bp-stat-value">
                {game.installSizeBytes ? formatBytes(game.installSizeBytes) : 'Unknown'}
              </div>
            </div>
          )}
          <div>
            <div className="bp-stat-label">Store</div>
            <div className="bp-stat-value">{storeLabel(game.store)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Fullscreen, controller-first mode modelled on Steam Big Picture's library: tabs with
 *  L1/R1, a capsule grid, a game page on A, and a button legend along the bottom. There is
 *  deliberately no home page - it opens straight into the library. */
export function BigPictureView({ games, settings, inputEnabled }: Props): React.JSX.Element {
  const primaryAction = useAppStore((s) => s.primaryAction)
  const openDetails = useAppStore((s) => s.openDetails)
  const setBigPicture = useAppStore((s) => s.setBigPicture)
  const activeDownloads = useAppStore(
    (s) => Object.values(s.downloads).filter((d) => d.status === 'active').length
  )

  // Same order and stores as the desktop sidebar, so both modes navigate alike.
  const tabs: Tab[] = useMemo(() => {
    const list: Tab[] = [
      { key: 'all', label: 'All games', filter: () => true },
      { key: 'installed', label: 'Installed', filter: (g) => g.isInstalled },
      { key: 'steam', label: 'Steam', filter: (g) => g.store === 'steam' },
      { key: 'gog', label: 'GOG', filter: (g) => g.store === 'gog' }
    ]
    if (settings?.enabledStores.epic) {
      list.push({ key: 'epic', label: 'Epic', filter: (g) => g.store === 'epic' })
    }
    if (settings?.enabledStores.amazon) {
      list.push({ key: 'amazon', label: 'Amazon', filter: (g) => g.store === 'amazon' })
    }
    list.push({ key: 'downloads', label: 'Downloads' })
    return list
  }, [settings])

  const [tabKey, setTabKey] = useState('all')
  const [indexByTab, setIndexByTab] = useState<Record<string, number>>({})
  const [pageGameId, setPageGameId] = useState<string | null>(null)
  const [pageFocus, setPageFocus] = useState(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLElement>(null)

  // Like Steam's Big Picture: the cursor only shows while the mouse is actually being
  // used - it hides after a moment of no movement, and immediately on controller/keyboard
  // input. Applied to the whole document so it covers Big Picture's modals too.
  useEffect(() => {
    const root = document.documentElement
    let timer: ReturnType<typeof setTimeout> | null = null
    const hide = (): void => root.classList.add('hide-cursor')
    const onMove = (e: MouseEvent): void => {
      if (e.movementX === 0 && e.movementY === 0) return
      root.classList.remove('hide-cursor')
      if (timer) clearTimeout(timer)
      timer = setTimeout(hide, 2000)
    }
    const onOtherInput = (): void => {
      if (timer) clearTimeout(timer)
      hide()
    }
    hide()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('keydown', onOtherInput)
    const pad = setInterval(() => {
      const p = navigator.getGamepads?.()[0]
      if (p && p.buttons.some((b) => b.pressed)) onOtherInput()
    }, 250)
    return () => {
      if (timer) clearTimeout(timer)
      clearInterval(pad)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('keydown', onOtherInput)
      root.classList.remove('hide-cursor')
    }
  }, [])

  const tab = tabs.find((t) => t.key === tabKey) ?? tabs[0]
  const tabGames = useMemo(() => (tab.filter ? games.filter(tab.filter) : []), [games, tab])
  const index = Math.min(indexByTab[tab.key] ?? 0, Math.max(0, tabGames.length - 1))
  const focusedGame = tabGames[index]
  const pageGame = pageGameId ? games.find((g) => g.id === pageGameId) : undefined

  const gridColumns = (): number => {
    const el = gridRef.current
    const first = el?.children[0] as HTMLElement | undefined
    if (!el || !first) return 1
    return Array.from(el.children).filter((c) => (c as HTMLElement).offsetTop === first.offsetTop)
      .length
  }

  // On the first row, scroll the whole page to the very top - "nearest" alone stops at the
  // capsule's edge, leaving the tab header and the focus ring cut off above it.
  useEffect(() => {
    if (pageGameId || !tab.filter) return
    if (index < gridColumns()) contentRef.current?.scrollTo({ top: 0, behavior: 'instant' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, tab.key, pageGameId])

  const setIndex = (i: number): void => setIndexByTab((prev) => ({ ...prev, [tab.key]: i }))

  function openPage(id: string): void {
    setPageGameId(id)
    setPageFocus(0)
  }

  function move(dir: Dir): void {
    if (pageGame) {
      if (dir === 'right') setPageFocus(1)
      if (dir === 'left') setPageFocus(0)
      return
    }
    if (!tab.filter || tabGames.length === 0) return
    const cols = gridColumns()
    const step = dir === 'left' ? -1 : dir === 'right' ? 1 : dir === 'up' ? -cols : cols
    setIndex(Math.min(tabGames.length - 1, Math.max(0, index + step)))
  }

  // Functional update: several presses can land before a re-render (gamepad polling runs
  // every frame), and each must step from the latest tab, not a stale closure.
  function cycleTab(delta: 1 | -1): void {
    if (pageGame) return
    setTabKey((current) => {
      const i = tabs.findIndex((t) => t.key === current)
      return tabs[(i + delta + tabs.length) % tabs.length].key
    })
  }

  function confirm(): void {
    if (pageGame) {
      if (pageFocus === 0) primaryAction(pageGame.id)
      else openDetails(pageGame.id)
    } else if (focusedGame) openPage(focusedGame.id)
  }

  function back(): void {
    setPageGameId(null)
  }

  useGamepadNav({
    enabled: inputEnabled,
    onDirection: move,
    onConfirm: confirm,
    onBack: back,
    onTabLeft: () => cycleTab(-1),
    onTabRight: () => cycleTab(1),
    onOptions: () => {
      const g = pageGame ?? focusedGame
      if (g) openDetails(g.id)
    },
    onStart: () => setBigPicture(false)
  })

  useEffect(() => {
    if (!inputEnabled) return
    // Same actions as the gamepad - see keyNav.ts (also how the Steam Controller's
    // Desktop Layout drives this view). Back never exits Big Picture; Start/Menu does.
    function onKey(e: KeyboardEvent): void {
      if (typingInField()) return
      const action = keyNavAction(e)
      if (!action) return
      e.preventDefault()
      if (action === 'confirm') confirm()
      else if (action === 'back') back()
      else if (action === 'options') {
        const g = pageGame ?? focusedGame
        if (g) openDetails(g.id)
      } else if (action === 'tabLeft') cycleTab(-1)
      else if (action === 'tabRight') cycleTab(1)
      else if (action === 'start') setBigPicture(false)
      else move(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="bp-root">
      <header className="bp-topbar">
        <div className="bp-brand">
          <span className="dot" />
          OmniLauncher
        </div>
        <div className="bp-topbar-right">
          {activeDownloads > 0 && (
            <button
              className="bp-topbar-download"
              onClick={() => {
                setPageGameId(null)
                setTabKey('downloads')
              }}
            >
              <DownloadIcon size={18} />
              {activeDownloads}
            </button>
          )}
          <Clock />
        </div>
      </header>

      {pageGame ? (
        <GamePage game={pageGame} focusIndex={pageFocus} />
      ) : (
        <>
          <nav className="bp-tabs">
            <span className="bp-glyph-bumper">L1</span>
            {tabs.map((t) => (
              <button
                key={t.key}
                className={`bp-tab${t.key === tab.key ? ' active' : ''}`}
                onClick={() => setTabKey(t.key)}
              >
                {t.label}
                {t.key === 'downloads' && activeDownloads > 0 && (
                  <span className="bp-tab-badge">{activeDownloads}</span>
                )}
              </button>
            ))}
            <span className="bp-glyph-bumper">R1</span>
          </nav>

          <main className="bp-content" ref={contentRef}>
            {tab.filter ? (
              <>
                <div className="bp-library-header">
                  <span>{tab.label}</span>
                  <span className="bp-library-count">({tabGames.length})</span>
                  <span className="bp-library-sort">Sort by Alphabetical</span>
                </div>
                {tabGames.length === 0 ? (
                  <div className="bp-empty">No games here.</div>
                ) : (
                  <div className="bp-grid" ref={gridRef}>
                    {tabGames.map((g, i) => (
                      <Capsule
                        key={g.id}
                        game={g}
                        focused={i === index}
                        onFocus={() => setIndex(i)}
                        onActivate={() => openPage(g.id)}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <DownloadsView big />
            )}
          </main>
        </>
      )}

      <footer className="bp-legend">
        {!pageGame && tab.filter && focusedGame && (
          <span className="bp-legend-title">{focusedGame.title}</span>
        )}
        <span className="bp-legend-spacer" />
        {(pageGame || (tab.filter && focusedGame)) && (
          <span>
            <i className="bp-glyph a">A</i> {pageGame && pageFocus === 1 ? 'Options' : 'Select'}
          </span>
        )}
        {pageGame && (
          <span>
            <i className="bp-glyph b">B</i> Back
          </span>
        )}
        {(pageGame || focusedGame) && (
          <span>
            <i className="bp-glyph y">Y</i> Options
          </span>
        )}
        <span>
          <i className="bp-glyph menu">☰</i> Exit Big Picture
        </span>
      </footer>
    </div>
  )
}
