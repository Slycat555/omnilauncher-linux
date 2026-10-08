import { useEffect, useRef, useState } from 'react'
import { createStore } from 'zustand/vanilla'
import type {
  AppSettings,
  CoverOption,
  DetectionResult,
  InstallPhase,
  InstallProgressEvent,
  StoreAuthStatus,
  StoreKind,
  UnifiedGame,
  WineActivity
} from '../../shared/types'

export type StoreFilter = 'all' | StoreKind

/** How many one-second speed samples the Downloads network graph keeps (2 minutes). */
export const DOWNLOAD_SAMPLES = 120

/** One install as shown on the Downloads page - created when an install starts and kept
 *  (as completed/failed/cancelled) until the user clears it, like Steam's own list. */
export interface DownloadEntry {
  gameId: string
  /** 'queued' installs wait for the active one to finish - only one runs at a time. */
  status: 'queued' | 'active' | 'done' | 'error' | 'cancelled'
  phase: InstallPhase
  startedAt: number
  finishedAt?: number
  percent?: number
  downloadedBytes?: number
  totalBytes?: number
  /** Current speed in bytes/s - 0 once the backend has gone quiet for a few seconds. */
  speedBps: number
  peakBps: number
  /** Speed once per second, oldest first - drives the network graph. */
  samples: number[]
  /** ETA as printed by the backend CLI, when it prints one. */
  eta?: string
  message?: string
  /** Last byte reading and when it was taken, for deriving speed when the backend
   *  reports bytes but no speed (Steam, which only exposes its manifest). */
  lastBytes?: number
  lastBytesAt?: number
  lastSpeedAt: number
}

/** Seconds of silence after which the current speed is shown as 0 rather than frozen at
 *  the last value - Steam's manifest and the CLIs both stop updating while stalled. */
const SPEED_STALE_MS = 6000

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

  downloads: Record<string, DownloadEntry>
  clearFinishedDownloads: () => void

  /** Fullscreen, controller-first Big Picture mode (BigPictureView.tsx). */
  bigPicture: boolean
  setBigPicture: (on: boolean) => void

  /** Any Wine/Proton process running on the system, from the main process's monitor -
   *  the whole UI is locked while this is active (see WineLockOverlay). */
  wineActivity: WineActivity

  coverPickerGameId: string | null
  coverPickerOptions: CoverOption[]
  coverPickerLoading: boolean

  /** Which game's Artwork/NFC details panel is open, if any - null when closed. Only
   *  one at a time, same as the cover picker. */
  detailsGameId: string | null
  openDetails: (gameId: string) => void
  closeDetails: () => void

  /** Live login state for GOG/Epic/Amazon - null until the first check completes. Used
   *  to hide a store's owned-but-not-installed catalog once logged out (installed games
   *  stay visible regardless, since those are real files on disk either way). */
  authStatus: StoreAuthStatus | null
  refreshAuthStatus: () => Promise<void>

  /** Whether a PN532 reader was detected at startup - gates whether "Write to NFC tag"
   *  shows up in the card menu at all. */
  nfcAvailable: boolean
  writeGameToTag: (gameId: string) => Promise<void>

  /** Set briefly when a tag scan launches a game, driving a full-screen "Launching…"
   *  overlay (cover art + title) - null when nothing's showing. */
  nfcLaunchGameId: string | null

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
  loadCover: (gameId: string, priority?: boolean) => Promise<void>
  /** Loads covers for every game in the library in the background, not just whichever
   *  store/filter is currently visible - so switching filters never shows a fresh
   *  batch of blank-then-pop-in cards. */
  precacheAllCovers: () => Promise<void>

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
  wineActivity: { active: false, gameIds: [] },
  downloads: {},
  clearFinishedDownloads: () =>
    set((state) => ({
      downloads: Object.fromEntries(
        Object.entries(state.downloads).filter(
          ([, d]) => d.status === 'active' || d.status === 'queued'
        )
      )
    })),
  bigPicture: false,
  setBigPicture: (on) => {
    set({ bigPicture: on })
    void window.api.setFullscreen(on)
  },

  coverPickerGameId: null,
  coverPickerOptions: [],
  coverPickerLoading: false,

  detailsGameId: null,
  openDetails: (gameId) => set({ detailsGameId: gameId }),
  closeDetails: () => set({ detailsGameId: null }),

  authStatus: null,
  refreshAuthStatus: async () => {
    const authStatus = await window.api.getAuthStatus()
    set({ authStatus })
  },

  nfcAvailable: false,
  // No toast here on purpose - the write flow only ever happens from
  // GameDetailsPanel, which shows its own inline "Tag written"/error state instead of a
  // popup. Errors are rethrown so that panel can catch and display them itself.
  writeGameToTag: (gameId) => window.api.writeGameToTag(gameId),

  nfcLaunchGameId: null,

  init: async () => {
    set({ loading: true })
    // Subscribed before the (slow) library scan below, not after it like the other
    // listeners - a game may already be running when the launcher starts, and the UI
    // has to be locked from the very first paint, not once covers finish loading.
    window.api.onWineActivity((wineActivity) => set({ wineActivity }))
    void window.api.getWineActivity().then((wineActivity) => set({ wineActivity }))
    try {
      const [cached, detection, settings] = await Promise.all([
        window.api.getLibrary(),
        window.api.detectAll(),
        window.api.getSettings()
      ])
      set({ games: cached, detection, settings })
      if (settings.startInBigPicture) get().setBigPicture(true)
      // Wait for the first screenful's worth of covers before ever showing the grid -
      // without this, every card rendered its plain placeholder first and then popped
      // in the real art the instant its fetch resolved, all across the grid, visibly at
      // slightly different times. Sorted the same way GameGrid sorts (alphabetically by
      // title) so "first N" actually matches what's likely on screen first, not an
      // arbitrary N games that happen to be first in the unsorted list. Bounded (not the
      // whole library) so a large library doesn't turn this into a long loading screen -
      // INITIAL_COVER_BATCH is generously sized for any realistic grid viewport.
      const firstBatch = [...cached].sort((a, b) => a.title.localeCompare(b.title))
      await Promise.all(
        firstBatch.slice(0, INITIAL_COVER_BATCH).map((g) => get().loadCover(g.id, true))
      )
      set({ loading: false })
      // Everything beyond the first batch, and every game in the batch that's about to
      // be filtered out by a non-"all" store filter, still needs to be precached in the
      // background so switching filters later has nothing left to fetch either.
      void get().precacheAllCovers()
      void get().refreshAuthStatus()
      void window.api.isNfcAvailable().then((nfcAvailable) => set({ nfcAvailable }))
      window.api.onNfcTagScanned((gameId) => {
        if (get().wineActivity.active) return
        const game = get().games.find((g) => g.id === gameId)
        if (!game) return
        // Only show the launch overlay when the scan actually results in launching the
        // game - not on the install/cancel-install paths primaryAction() can also take
        // depending on the game's current state, since only a real launch is what the
        // user asked to be notified about.
        if (game.isInstalled && game.canLaunch) {
          void get().loadCover(gameId)
          set({ nfcLaunchGameId: gameId })
          setTimeout(() => {
            if (get().nfcLaunchGameId === gameId) set({ nfcLaunchGameId: null })
          }, 3000)
        }
        get().primaryAction(gameId)
      })
      // The reader isn't always plugged in yet the instant the app starts (or gets
      // replugged mid-session) - the main process keeps retrying detection in the
      // background and pushes this once it actually connects, so the "Write to NFC tag"
      // option can appear without needing an app restart.
      window.api.onNfcAvailabilityChanged((nfcAvailable) => set({ nfcAvailable }))

      window.api.onInstallProgress((evt) => {
        set((state) => {
          let download = state.downloads[evt.gameId]
          // A download started outside OmniLauncher (in Steam): its first progress event
          // creates the entry, so it shows on the Downloads page like one of ours.
          let games = state.games
          if (evt.external && evt.phase === 'downloading' && download?.status !== 'active') {
            download = newDownload(evt.gameId)
            games = games.map((g) => (g.id === evt.gameId ? { ...g, isInstalling: true } : g))
          }
          if (evt.external && (evt.phase === 'done' || evt.phase === 'cancelled')) {
            games = games.map((g) => (g.id === evt.gameId ? { ...g, isInstalling: false } : g))
          }
          const downloads =
            download && download.status === 'active'
              ? { ...state.downloads, [evt.gameId]: applyProgress(download, evt) }
              : state.downloads
          const nextLines = [...(state.consoleLog[evt.gameId] ?? [])]
          if (evt.raw) {
            nextLines.push(evt.raw)
            if (nextLines.length > MAX_LOG_LINES) nextLines.shift()
          } else if (evt.message) {
            nextLines.push(evt.message)
          }
          return {
            progress: { ...state.progress, [evt.gameId]: evt },
            consoleLog: { ...state.consoleLog, [evt.gameId]: nextLines },
            downloads,
            games
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
      // One graph sample per second for every active download, independent of how often
      // the backend happens to print - legendary prints every ~1s, Steam's manifest is
      // polled every 1.5s, so sampling on events alone would make the graph stutter.
      setInterval(() => {
        const now = Date.now()
        const active = Object.values(get().downloads).filter((d) => d.status === 'active')
        if (active.length === 0) return
        set((state) => {
          const downloads = { ...state.downloads }
          for (const d of active) {
            const speedBps = now - d.lastSpeedAt > SPEED_STALE_MS ? 0 : d.speedBps
            downloads[d.gameId] = {
              ...d,
              speedBps,
              peakBps: Math.max(d.peakBps, speedBps),
              samples: [...d.samples, speedBps].slice(-DOWNLOAD_SAMPLES)
            }
          }
          return { downloads }
        })
      }, 1000)
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
      void get().precacheAllCovers()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: message, toast: `Failed to refresh library: ${message}` })
    }
  },

  precacheAllCovers: async () => {
    // Not priority - this must never jump ahead of a card or the details panel actively
    // on screen right now, it just needs to eventually cover the whole library so a
    // later filter switch has nothing left to fetch.
    await Promise.all(get().games.map((g) => get().loadCover(g.id)))
  },

  setSearch: (q) => set({ searchQuery: q }),
  setStoreFilter: (f) => set({ storeFilter: f, installedOnly: false }),
  toggleInstalledOnly: () =>
    set((state) => ({ installedOnly: !state.installedOnly, storeFilter: 'all' })),
  dismissToast: () => set({ toast: null }),

  install: async (gameId) => {
    // One download at a time: anything started while another is running waits its turn
    // and is picked up by startNextQueued() when the active one ends.
    const busy = Object.values(get().downloads).some((d) => d.status === 'active')
    set((state) => ({
      games: state.games.map((g) => (g.id === gameId ? { ...g, isInstalling: true } : g)),
      consoleLog: { ...state.consoleLog, [gameId]: [] },
      downloads: {
        ...state.downloads,
        [gameId]: busy ? { ...newDownload(gameId), status: 'queued' } : newDownload(gameId)
      }
    }))
    if (!busy) await runInstall(gameId)
  },

  cancelInstall: async (gameId) => {
    // A queued install never reached the backend - just drop it from the queue.
    if (get().downloads[gameId]?.status === 'queued') {
      set((state) => {
        const downloads = { ...state.downloads }
        delete downloads[gameId]
        return {
          downloads,
          games: state.games.map((g) => (g.id === gameId ? { ...g, isInstalling: false } : g))
        }
      })
      return
    }
    set((state) => ({ downloads: finishDownload(state.downloads, gameId, 'cancelled') }))
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

  loadCover: async (gameId, priority = false) => {
    if (get().covers[gameId]) return
    try {
      const { resolved, ...result } = await runThrottled(
        () => window.api.getCoverArt(gameId),
        priority
      )
      // resolved: false means this attempt didn't actually complete (main process's
      // game index wasn't populated yet, a fetch failed) - it is NOT a real "no art"
      // answer, and must not be cached, or the thumbnail would stay blank for the rest
      // of the session with no way to retry. Only a genuine result (found art, or
      // confirmed nothing to fetch) gets cached.
      if (!resolved) return
      if (result.cover) warmImage(result.cover)
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

/** Decoded cover images kept alive for the session. Fetching + decoding each cover once,
 *  up front, means a card that mounts later (tab switch, scrolling back, Big Picture)
 *  paints its art in the same frame from memory instead of loading/flickering in. */
const warmImages = new Map<string, HTMLImageElement>()
function warmImage(url: string): void {
  if (warmImages.has(url)) return
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  warmImages.set(url, img)
  img.decode().catch(() => {})
}

/** Runs one install through the backend, then hands over to the next queued one. */
async function runInstall(gameId: string): Promise<void> {
  const set = store.setState
  try {
    await window.api.installGame(gameId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    set((state) => ({
      toast: `Install failed: ${message}`,
      consoleLog: { ...state.consoleLog, [gameId]: [...(state.consoleLog[gameId] ?? []), message] },
      downloads: finishDownload(state.downloads, gameId, 'error', message)
    }))
  } finally {
    set((state) => ({
      games: state.games.map((g) => (g.id === gameId ? { ...g, isInstalling: false } : g)),
      // The backend can return without a final event (e.g. cancelled before starting) -
      // make sure the entry isn't left "active", or the queue would never move on.
      downloads: finishDownload(state.downloads, gameId, 'cancelled')
    }))
    void startNextQueued()
  }
}

/** Starts the oldest queued install, if nothing else is downloading. */
async function startNextQueued(): Promise<void> {
  const { downloads } = store.getState()
  if (Object.values(downloads).some((d) => d.status === 'active')) return
  const next = Object.values(downloads)
    .filter((d) => d.status === 'queued')
    .sort((a, b) => a.startedAt - b.startedAt)[0]
  if (!next) return
  store.setState((state) => ({
    downloads: { ...state.downloads, [next.gameId]: newDownload(next.gameId) }
  }))
  await runInstall(next.gameId)
}

function newDownload(gameId: string): DownloadEntry {
  const now = Date.now()
  return {
    gameId,
    status: 'active',
    phase: 'starting',
    startedAt: now,
    speedBps: 0,
    peakBps: 0,
    samples: [],
    lastSpeedAt: now
  }
}

/** Marks a still-active download as finished; already-finished ones are left alone so a
 *  late error/cancel can't overwrite a real "done". */
function finishDownload(
  downloads: Record<string, DownloadEntry>,
  gameId: string,
  status: 'done' | 'error' | 'cancelled',
  message?: string
): Record<string, DownloadEntry> {
  const d = downloads[gameId]
  if (!d || d.status !== 'active') return downloads
  return {
    ...downloads,
    [gameId]: {
      ...d,
      status,
      message: message ?? d.message,
      finishedAt: Date.now(),
      speedBps: 0,
      percent: status === 'done' ? 100 : d.percent
    }
  }
}

function applyProgress(d: DownloadEntry, evt: InstallProgressEvent): DownloadEntry {
  if (evt.phase === 'done' || evt.phase === 'error' || evt.phase === 'cancelled') {
    const status = evt.phase === 'done' ? 'done' : evt.phase
    return finishDownload({ [d.gameId]: d }, d.gameId, status, evt.message)[d.gameId]
  }

  const now = Date.now()
  const next: DownloadEntry = {
    ...d,
    phase: evt.phase,
    percent: evt.percent ?? d.percent,
    downloadedBytes: evt.downloadedBytes ?? d.downloadedBytes,
    totalBytes: evt.totalBytes ?? d.totalBytes,
    eta: evt.eta ?? d.eta,
    message: evt.phase === 'starting' ? (evt.message ?? d.message) : d.message
  }

  if (evt.speedBps !== undefined) {
    next.speedBps = evt.speedBps
    next.lastSpeedAt = now
  } else if (evt.downloadedBytes !== undefined) {
    // Derive speed from the byte delta; ignore readings too close together to be
    // meaningful (the same manifest state can be reported twice in quick succession).
    if (d.lastBytes !== undefined && d.lastBytesAt !== undefined) {
      const seconds = (now - d.lastBytesAt) / 1000
      if (seconds >= 0.5 && evt.downloadedBytes >= d.lastBytes) {
        next.speedBps = (evt.downloadedBytes - d.lastBytes) / seconds
        next.lastSpeedAt = now
      }
    }
    if (d.lastBytesAt === undefined || (now - d.lastBytesAt) / 1000 >= 0.5) {
      next.lastBytes = evt.downloadedBytes
      next.lastBytesAt = now
    }
  }
  return next
}

// How many covers init() waits for before showing the grid at all - generous for any
// realistic first screenful so nothing visible pops in, without turning a large
// library into a long loading screen waiting on covers nobody's looking at yet.
const INITIAL_COVER_BATCH = 20

// A whole grid's worth of cards mounting at once would otherwise fire dozens of
// simultaneous ipcRenderer.invoke('covers:get') calls in the same tick.
const COVER_LOAD_CONCURRENCY = 4
let activeCoverLoads = 0
const coverLoadQueue: Array<() => void> = []

/** priority: true jumps the queue instead of joining the back of it - used when opening
 *  GameDetailsPanel for a game whose cover hasn't loaded yet, so the one thing the user
 *  is actively looking at doesn't sit behind however many grid-card fetches happened to
 *  already be queued (a real, visible delay on any library with more than a screenful
 *  of games - the plain FIFO queue had no way to distinguish "background prefetch" from
 *  "the user is staring at a blank spot right now"). */
function runThrottled<T>(fn: () => Promise<T>, priority = false): Promise<T> {
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
    else if (priority) coverLoadQueue.unshift(run)
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
