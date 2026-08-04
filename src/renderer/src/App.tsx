import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CoverPicker } from './components/CoverPicker'
import { GameDetailsPanel } from './components/GameDetailsPanel'
import { GameGrid } from './components/GameGrid'
import { NfcLaunchOverlay } from './components/NfcLaunchOverlay'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { Titlebar } from './components/Titlebar'
import { Toast } from './components/Toast'
import { TopBar } from './components/TopBar'
import type { StoreFilter } from './store'
import { useAppStore } from './store'
import { useGamepadNav } from './useGamepadNav'

function App(): React.JSX.Element {
  const {
    games,
    detection,
    settings,
    loading,
    searchQuery,
    storeFilter,
    installedOnly,
    manageMode,
    runningGameIds,
    authStatus,
    init,
    refresh,
    setSearch,
    setStoreFilter,
    toggleInstalledOnly,
    primaryAction,
    toggleManageMode
  } = useAppStore()

  const anyGameRunning = Object.keys(runningGameIds).length > 0

  const [view, setView] = useState<'library' | 'settings'>('library')
  const [focusedIndex, setFocusedIndex] = useState(0)
  // Mouse hover moves the same focus keyboard/gamepad nav uses (so the outline follows
  // whichever input moved most recently - see GameGrid's onMouseEnter), but unlike
  // keyboard/gamepad it must never drive scrolling: nothing about moving the mouse over
  // an already-visible card should yank the scroll position out from under it. Tracked
  // outside React state (a plain ref, not something a render depends on) since it's
  // consulted only inside the scroll-follow effect below, not rendered anywhere.
  const focusSourceRef = useRef<'mouse' | 'nav'>('nav')
  const gridRef = useRef<HTMLDivElement>(null)
  // Measured (not computed from CSS) - a card's real height depends on content (title
  // wrapping, "Installing..." subtext), not just fixed constants. Shared between the
  // scroll-follow effect below and GameGrid's own virtualization windowing, so both
  // agree on exactly the same row height rather than each guessing independently and
  // risking drift between "where the math thinks row N is" and "where it actually is".
  const [rowHeight, setRowHeight] = useState(0)

  useEffect(() => {
    void init()
  }, [init])

  // CSS zoom (not transform: scale) so hit-testing/layout scale together with the visual
  // size - a controller/mouse click still lands where the bigger button visually is.
  useEffect(() => {
    document.documentElement.style.zoom = String(settings?.uiScale ?? 1)
  }, [settings?.uiScale])

  const visibleGames = useMemo(() => {
    const epicOn = settings?.enabledStores.epic ?? false
    const amazonOn = settings?.enabledStores.amazon ?? false
    return games.filter((g) => {
      if (g.store === 'epic' && !epicOn) return false
      if (g.store === 'amazon' && !amazonOn) return false
      // A logged-out store's owned-but-not-installed catalog is stale (last synced
      // while still logged in) and can't be acted on anyway - hide it. Anything already
      // installed stays regardless, since those are real files on disk either way, not
      // dependent on the current login session.
      if (g.store === 'gog' && authStatus && !authStatus.gog && !g.isInstalled) return false
      if (g.store === 'epic' && authStatus && !authStatus.epic && !g.isInstalled) return false
      if (g.store === 'amazon' && authStatus && !authStatus.amazon && !g.isInstalled) return false
      return true
    })
  }, [games, settings, authStatus])

  const filteredGames = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    // A single malformed entry from a backend (missing title) must never be able to
    // throw here - that crashes the whole render tree, not just that one card.
    return visibleGames
      .filter((g) => typeof g.title === 'string' && g.title.length > 0)
      .filter((g) => (storeFilter === 'all' ? true : g.store === storeFilter))
      .filter((g) => (installedOnly ? g.isInstalled : true))
      .filter((g) => (q ? g.title.toLowerCase().includes(q) : true))
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [visibleGames, storeFilter, installedOnly, searchQuery])

  useEffect(() => {
    focusSourceRef.current = 'nav'
    setFocusedIndex(0)
    // Switching tabs/filters is a new view, not a navigation step within the current one -
    // it should always land at the top immediately, never carry over the previous tab's
    // scroll position or animate the transition the way keyboard/gamepad focus-follow does.
    gridRef.current?.scrollTo({ top: 0, behavior: 'instant' })
  }, [storeFilter, installedOnly, searchQuery])

  // Measures actual rendered row height (card + gap) from whatever .game-card happens
  // to be mounted right now - GameGrid only mounts cards near the viewport (see its own
  // comment), so this can't assume a specific card/row is present, just that at least
  // one is. Re-measured on layout changes (columns changing reflows card width, which
  // changes card height too since art is a fixed 2:3 aspect ratio).
  useLayoutEffect(() => {
    const container = gridRef.current
    if (!container) return
    const recompute = (): void => {
      const card = container.querySelector<HTMLElement>('.game-card')
      if (card) setRowHeight(card.getBoundingClientRect().height + 16)
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(container)
    return () => ro.disconnect()
  }, [filteredGames])

  // Moving focus with a controller/keyboard has no mouse wheel to fall back on, so the
  // focused card has to bring itself into view - the .main container scrolls, but
  // nothing was ever telling it to follow focus.
  //
  // Computed by row math (index / columns * rowHeight), not scrollIntoView() on a
  // queried DOM node: GameGrid virtualizes now (only mounts cards near the viewport),
  // so the focused card's element frequently doesn't exist in the DOM at all when focus
  // jumps there directly (e.g. a bumper press skipping several rows) - querying for it
  // would silently find nothing and never scroll, stranding keyboard/gamepad
  // navigation on an off-screen card with no way to see where focus actually went.
  //
  // Skipped entirely when the mouse moved focus (focusSourceRef.current === 'mouse'):
  // hovering is expected to move the highlight outline without ever driving scroll -
  // the previous version unconditionally snapped to the very top/bottom whenever focus
  // landed on the first/last row, which meant just hovering a card in that row (even
  // one already fully visible) yanked the scroll position, which is what read as "the
  // mouse makes the library scroll."
  useEffect(() => {
    const container = gridRef.current
    const game = filteredGames[focusedIndex]
    if (!container || !game || rowHeight === 0) return
    if (focusSourceRef.current === 'mouse') return
    const cols = columns()
    // `scrollIntoView({ block: 'nearest' })` only scrolls the minimum distance needed to
    // clear the viewport edge, so the top/bottom row never actually reaches the true edge
    // of the container (a sliver of the next row stays visible, or padding is left
    // uncovered) - snap all the way when focus is on the first or last row instead.
    if (focusedIndex < cols) {
      container.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (focusedIndex >= filteredGames.length - cols) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
      return
    }
    const row = Math.floor(focusedIndex / cols)
    const rowTop = row * rowHeight
    const rowBottom = rowTop + rowHeight
    const viewTop = container.scrollTop
    const viewBottom = viewTop + container.clientHeight
    // Manual "nearest" equivalent: only scroll if the row isn't already fully visible,
    // and scroll by exactly the distance needed to bring the nearer edge into view -
    // matches scrollIntoView({block: 'nearest'})'s behavior without needing the actual
    // element.
    if (rowTop < viewTop) {
      container.scrollTo({ top: rowTop, behavior: 'smooth' })
    } else if (rowBottom > viewBottom) {
      container.scrollTo({ top: rowBottom - container.clientHeight, behavior: 'smooth' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedIndex, filteredGames, rowHeight])

  function columns(): number {
    const el = gridRef.current
    if (!el || el.clientWidth === 0) return 6
    return Math.max(1, Math.floor(el.clientWidth / (160 + 16)))
  }

  function move(dir: 'up' | 'down' | 'left' | 'right'): void {
    if (view !== 'library' || filteredGames.length === 0) return
    focusSourceRef.current = 'nav'
    const cols = columns()
    setFocusedIndex((i) => {
      let next = i
      if (dir === 'right') next = i + 1
      if (dir === 'left') next = i - 1
      if (dir === 'down') next = i + cols
      if (dir === 'up') next = i - cols
      return Math.min(filteredGames.length - 1, Math.max(0, next))
    })
  }

  // Mirrors the sidebar's own nav order (Sidebar.tsx) so LB/RB cycles through exactly
  // what's visible there - 'installed' is a distinct stop, not a toggle-in-place, since
  // a bumper press has no notion of "toggle off" the way clicking the button again does.
  type Tab = 'all' | 'installed' | StoreFilter
  const tabs: Tab[] = useMemo(() => {
    const stores: StoreFilter[] = ['steam', 'gog']
    if (settings?.enabledStores.epic) stores.push('epic')
    if (settings?.enabledStores.amazon) stores.push('amazon')
    return ['all', 'installed', ...stores]
  }, [settings])

  function currentTab(): Tab {
    if (installedOnly) return 'installed'
    return storeFilter
  }

  function cycleTab(delta: 1 | -1): void {
    const idx = tabs.indexOf(currentTab())
    const next = tabs[(idx + delta + tabs.length) % tabs.length]
    if (next === 'installed') {
      if (!installedOnly) toggleInstalledOnly()
    } else {
      setStoreFilter(next)
    }
  }

  useGamepadNav({
    // A controller is normally driving this UI, but the same controller is also what's
    // driving whatever Proton/native game just launched - without this, a bumper or
    // face-button press meant for the game (which has no window focus tug-of-war to
    // rely on, since both read raw gamepad state independently) could just as easily
    // land on the launcher and fire another install/launch/tab switch mid-session.
    enabled: view === 'library' && !anyGameRunning,
    onDirection: move,
    onConfirm: () => {
      const g = filteredGames[focusedIndex]
      if (g && !manageMode) primaryAction(g.id)
    },
    onBack: () => {},
    onTabLeft: () => cycleTab(-1),
    onTabRight: () => cycleTab(1)
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (document.activeElement?.tagName === 'INPUT') return
      if (e.key === 'Escape' && manageMode) toggleManageMode()
      else if (e.key === 'ArrowRight') move('right')
      else if (e.key === 'ArrowLeft') move('left')
      else if (e.key === 'ArrowDown') move('down')
      else if (e.key === 'ArrowUp') move('up')
      else if (e.key === 'Enter' && !manageMode) {
        const g = filteredGames[focusedIndex]
        if (g) primaryAction(g.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredGames, focusedIndex, manageMode])

  const focusedGame = filteredGames[focusedIndex]

  return (
    <div className="app-root">
      <Titlebar />
      <div className="app-shell">
        <Sidebar
          games={visibleGames}
          settings={settings}
          storeFilter={storeFilter}
          onStoreFilter={setStoreFilter}
          installedOnly={installedOnly}
          onToggleInstalledOnly={toggleInstalledOnly}
          view={view}
          onView={setView}
        />
        <TopBar query={searchQuery} onQuery={setSearch} onRefresh={refresh} />
        <div className="main" ref={gridRef}>
          {view === 'settings' ? (
            <SettingsView detection={detection} />
          ) : loading ? (
            <div className="empty-state">Scanning Steam &amp; Heroic…</div>
          ) : (
            <GameGrid
              games={filteredGames}
              focusedId={focusedGame?.id ?? null}
              onHoverIndex={(i) => {
                focusSourceRef.current = 'mouse'
                setFocusedIndex(i)
              }}
              scrollContainer={gridRef.current}
              rowHeight={rowHeight}
            />
          )}
        </div>
        <Toast />
        <CoverPicker />
        <GameDetailsPanel />
        <NfcLaunchOverlay />
      </div>
    </div>
  )
}

export default App
