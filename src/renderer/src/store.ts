import { useEffect, useRef, useState } from 'react'
import { createStore } from 'zustand/vanilla'
import type {
  AppSettings,
  CoverOption,
  DetectionResult,
  InstallProgressEvent,
  StoreAuthStatus,
  StoreKind,
  UnifiedGame
} from '../../shared/types'

export type StoreFilter = 'all' | StoreKind

interface AppState {
  games: UnifiedGame[]
  detection: DetectionResult | null
  settings: AppSettings | null
  loading: boolean
  error: string | null

  searchQuery: string
  storeFilter: StoreFilter
  installedOnly: boolean

  progress: Record<string, InstallProgressEvent>
  consoleLog: Record<string, string[]>
  covers: Record<string, { cover: string | null; hero: string | null }>
  toast: string | null

  manageMode: boolean
  selectedForManage: Record<string, true>
  bulkUninstalling: boolean

  /** ids of games currently running, from the main process's own liveness checks -
   *  used to disable gamepad navigation while in-game, so a controller input meant
   *  for the game itself can never accidentally launch/switch something in the UI. */
  runningGameIds: Record<string, true>

  coverPickerGameId: string | null
  coverPickerOptions: CoverOption[]
  coverPickerLoading: boolean

  /** Live login state for GOG/Epic/Amazon - null until the first check completes. Used
   *  to hide a store's owned-but-not-installed catalog once logged out (installed games
   *  stay visible regardless, since those are real files on disk either way). */
  authStatus: StoreAuthStatus | null
  refreshAuthStatus: () => Promise<void>

  init: () => Promise<void>
  refresh: () => Promise<void>
  setSearch: (q: string) => void
  setStoreFilter: (f: StoreFilter) => void
  toggleInstalledOnly: () => void
  dismissToast: () => void
  install: (gameId: string) => Promise<void>
  cancelInstall: (gameId: string) => Promise<void>
  uninstall: (gameId: string) => Promise<void>
  launch: (gameId: string) => Promise<void>
  /** install / play / cancel depending on the game's current state - used by keyboard & gamepad confirm */
  primaryAction: (gameId: string) => void
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  loadCover: (gameId: string) => Promise<void>

  toggleManageMode: () => void
  toggleGameSelected: (gameId: string) => void
  bulkUninstallSelected: () => Promise<void>

  openCoverPicker: (gameId: string) => Promise<void>
  closeCoverPicker: () => void
  chooseCover: (gameId: string, url: string) => Promise<void>
}

const MAX_LOG_LINES = 500

const store = createStore<AppState>((set, get) => ({
  games: [],
  detection: null,
  settings: null,
  loading: true,
  error: null,

  searchQuery: '',
  storeFilter: 'all',
  installedOnly: false,

  progress: {},
  consoleLog: {},
  covers: {},
  toast: null,

  manageMode: false,
  selectedForManage: {},
  bulkUninstalling: false,

  runningGameIds: {},

  coverPickerGameId: null,
  coverPickerOptions: [],
  coverPickerLoading: false,

  authStatus: null,
  refreshAuthStatus: async () => {
    const authStatus = await window.api.getAuthStatus()
    set({ authStatus })
  },

  init: async () => {
    set({ loading: true })
    try {
      const [cached, detection, settings] = await Promise.all([
        window.api.getLibrary(),
        window.api.detectAll(),
        window.api.getSettings()
      ])
      set({ games: cached, detection, settings, loading: false })
      void get().refreshAuthStatus()

      window.api.onInstallProgress((evt) => {
        set((state) => {
          const nextLines = [...(state.consoleLog[evt.gameId] ?? [])]
          if (evt.raw) {
            nextLines.push(evt.raw)
            if (nextLines.length > MAX_LOG_LINES) nextLines.shift()
          } else if (evt.message) {
            nextLines.push(evt.message)
          }
          return {
            progress: { ...state.progress, [evt.gameId]: evt },
            consoleLog: { ...state.consoleLog, [evt.gameId]: nextLines }
          }
        })
      })
      window.api.onLaunchState((evt) => {
        set((state) => {
          const runningGameIds = { ...state.runningGameIds }
          if (evt.running) runningGameIds[evt.gameId] = true
          else delete runningGameIds[evt.gameId]
          return {
            games: state.games.map((g) =>
              g.id === evt.gameId ? { ...g, canLaunch: !evt.running && g.isInstalled } : g
            ),
            runningGameIds
          }
        })
        if (evt.error) {
          set((state) => ({
            toast: `Launch failed: ${evt.error}`,
            consoleLog: {
              ...state.consoleLog,
              [evt.gameId]: [...(state.consoleLog[evt.gameId] ?? []), `Launch error: ${evt.error}`]
            }
          }))
        }
      })
      window.api.onLibraryUpdated((games) => set({ games }))
      window.api.onWarning((message) => set({ toast: message }))

      // fresh scan in the background so first paint is instant
      void get().refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: message, toast: `Failed to load library: ${message}` })
    }
  },

  refresh: async () => {
    try {
      const games = await window.api.refreshLibrary()
      set({ games })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: message, toast: `Failed to refresh library: ${message}` })
    }
  },

  setSearch: (q) => set({ searchQuery: q }),
  setStoreFilter: (f) => set({ storeFilter: f, installedOnly: false }),
  toggleInstalledOnly: () =>
    set((state) => ({ installedOnly: !state.installedOnly, storeFilter: 'all' })),
  dismissToast: () => set({ toast: null }),

  install: async (gameId) => {
    set((state) => ({
      games: state.games.map((g) => (g.id === gameId ? { ...g, isInstalling: true } : g)),
      consoleLog: { ...state.consoleLog, [gameId]: [] }
    }))
    try {
      await window.api.installGame(gameId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((state) => ({
        toast: `Install failed: ${message}`,
        consoleLog: { ...state.consoleLog, [gameId]: [...(state.consoleLog[gameId] ?? []), message] }
      }))
    } finally {
      set((state) => ({
        games: state.games.map((g) => (g.id === gameId ? { ...g, isInstalling: false } : g))
      }))
    }
  },

  cancelInstall: async (gameId) => {
    try {
      await window.api.cancelInstall(gameId)
    } catch (err) {
      set({ toast: `Cancel failed: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      set((state) => ({
        games: state.games.map((g) => (g.id === gameId ? { ...g, isInstalling: false } : g))
      }))
    }
  },

  uninstall: async (gameId) => {
    try {
      await window.api.uninstallGame(gameId)
    } catch (err) {
      set({ toast: `Uninstall failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  },

  launch: async (gameId) => {
    try {
      await window.api.launchGame(gameId)
    } catch (err) {
      set({ toast: `Launch failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  },

  primaryAction: (gameId) => {
    const game = get().games.find((g) => g.id === gameId)
    if (!game) return
    if (game.isInstalling) void get().cancelInstall(gameId)
    else if (game.isInstalled) {
      if (game.canLaunch) void get().launch(gameId)
    } else if (game.canInstall) void get().install(gameId)
  },

  saveSettings: async (patch) => {
    const settings = await window.api.saveSettings(patch)
    set({ settings })
  },

  loadCover: async (gameId) => {
    if (get().covers[gameId]) return
    try {
      const result = await runThrottled(() => window.api.getCoverArt(gameId))
      set((state) => ({ covers: { ...state.covers, [gameId]: result } }))
    } catch (err) {
      console.error('loadCover failed for', gameId, err)
    }
  },

  toggleManageMode: () =>
    set((state) => ({
      manageMode: !state.manageMode,
      selectedForManage: {}
    })),

  toggleGameSelected: (gameId) =>
    set((state) => {
      const next = { ...state.selectedForManage }
      if (next[gameId]) delete next[gameId]
      else next[gameId] = true
      return { selectedForManage: next }
    }),

  bulkUninstallSelected: async () => {
    const ids = Object.keys(get().selectedForManage)
    if (ids.length === 0) return
    set({ bulkUninstalling: true })
    try {
      for (const gameId of ids) {
        await get().uninstall(gameId)
      }
    } finally {
      set({ bulkUninstalling: false, manageMode: false, selectedForManage: {} })
    }
  },

  openCoverPicker: async (gameId) => {
    set({ coverPickerGameId: gameId, coverPickerOptions: [], coverPickerLoading: true })
    try {
      const options = await window.api.searchCoverOptions(gameId)
      // the picker may have been closed (or re-opened for a different game) while awaiting
      if (get().coverPickerGameId !== gameId) return
      set({ coverPickerOptions: options, coverPickerLoading: false })
      if (options.length === 0) {
        set({ toast: 'No cover art found on SteamGridDB for this game.' })
      }
    } catch (err) {
      if (get().coverPickerGameId !== gameId) return
      set({
        coverPickerLoading: false,
        toast: `Could not load cover options: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  },

  closeCoverPicker: () => set({ coverPickerGameId: null, coverPickerOptions: [], coverPickerLoading: false }),

  chooseCover: async (gameId, url) => {
    try {
      const cover = await window.api.chooseCover(gameId, url)
      set((state) => ({
        covers: { ...state.covers, [gameId]: { ...state.covers[gameId], cover } },
        coverPickerGameId: null,
        coverPickerOptions: []
      }))
    } catch (err) {
      set({ toast: `Could not set cover art: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
}))

// A whole grid's worth of cards mounting at once would otherwise fire dozens of
// simultaneous ipcRenderer.invoke('covers:get') calls in the same tick.
const COVER_LOAD_CONCURRENCY = 4
let activeCoverLoads = 0
const coverLoadQueue: Array<() => void> = []

function runThrottled<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = (): void => {
      activeCoverLoads++
      fn()
        .then(resolve, reject)
        .finally(() => {
          activeCoverLoads--
          const next = coverLoadQueue.shift()
          if (next) next()
        })
    }
    if (activeCoverLoads < COVER_LOAD_CONCURRENCY) run()
    else coverLoadQueue.push(run)
  })
}

/**
 * Manual store subscription (plain useState/useEffect) instead of zustand's
 * built-in React binding.
 *
 * The selected value is kept boxed in an object rather than stored directly. Selectors
 * here often return functions (`launch`, `loadCover`, ...), and React gives functions
 * special meaning in state: it treats them as lazy initialisers / updaters and *calls*
 * them with the previous state. An unboxed function value therefore ends up invoked as
 * `launch(previousState)`, which then tries to send a function over IPC and fails with
 * "An object could not be cloned". Boxing keeps state a plain object at all times.
 */
export function useAppStore<T = AppState>(selector?: (s: AppState) => T): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector

  const compute = (): T => {
    const state = store.getState()
    return selectorRef.current ? selectorRef.current(state) : (state as unknown as T)
  }
  const computeRef = useRef(compute)
  computeRef.current = compute

  const [box, setBox] = useState<{ value: T }>(() => ({ value: compute() }))

  useEffect(() => {
    const sync = (): void => {
      const next = computeRef.current()
      setBox((prev) => (Object.is(prev.value, next) ? prev : { value: next }))
    }
    const unsubscribe = store.subscribe(sync)
    // state may have changed between initial render and this effect running
    sync()
    return unsubscribe
  }, [])

  return box.value
}
