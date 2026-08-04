import { useEffect, useMemo, useRef, useState } from 'react'
import { CoverPicker } from './components/CoverPicker'
import { GameDetailsPanel } from './components/GameDetailsPanel'
import { GameGrid } from './components/GameGrid'
import { NfcLaunchOverlay } from './components/NfcLaunchOverlay'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
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
  const gridRef = useRef<HTMLDivElement>(null)

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
    setFocusedIndex(0)
  }, [storeFilter, installedOnly, searchQuery])

  // Moving focus with a controller/keyboard has no mouse wheel to fall back on, so the
  // focused card has to bring itself into view - the .main container scrolls, but
  // nothing was ever telling it to follow focus.
  useEffect(() => {
    const container = gridRef.current
    const game = filteredGames[focusedIndex]
    if (!container || !game) return
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
    const el = container.querySelector(`[data-game-id="${CSS.escape(game.id)}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedIndex, filteredGames])

  function columns(): number {
    const el = gridRef.current
    if (!el || el.clientWidth === 0) return 6
    return Math.max(1, Math.floor(el.clientWidth / (160 + 16)))
  }

  function move(dir: 'up' | 'down' | 'left' | 'right'): void {
    if (view !== 'library' || filteredGames.length === 0) return
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
            onHoverIndex={setFocusedIndex}
          />
        )}
      </div>
      <Toast />
      <CoverPicker />
      <GameDetailsPanel />
      <NfcLaunchOverlay />
    </div>
  )
}

export default App
