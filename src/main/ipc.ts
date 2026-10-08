import { BrowserWindow, ipcMain, shell } from 'electron'
import type {
  CompatInfo,
  ControllerModeInfo,
  ControllerModeSetting,
  InstallProgressEvent,
  LaunchStateEvent,
  SettingsPatch,
  StoreAuthStatus,
  UnifiedGame,
  WineActivity
} from '../shared/types'
import {
  amazonLoggedIn,
  epicLoggedIn,
  gogLoggedIn,
  loginAmazon,
  loginEpic,
  loginGog,
  logoutAmazon,
  logoutEpic,
  logoutGog
} from './clients/storeAuth'
import { loadSettings, saveSettings } from './config'
import { localCoverUrl } from './coverProtocol'
import {
  closeMainWindow,
  isMainWindowMaximized,
  minimizeMainWindow,
  setMainWindowFullscreen,
  showMainWindow,
  toggleMaximizeMainWindow
} from './index'
import { installManager, type RuntimeContext as InstallCtx } from './installManager'
import {
  launchGame,
  syncGamescopeLaunchOptions,
  type RuntimeContext as LaunchCtx
} from './launchManager'
import { detectControllerMode } from './controllerSupport'
import { getControllerMode, setControllerMode, startUiInput } from './omniInput'
import { enableSteamRemoteDebugging, isSteamRunning } from './clients/steam'
import { detectAll, getCachedLibrary, getRuntimeDetections, refreshLibrary } from './library'
import { isNfcAvailable, startNfcWatcher, writeGameToTag } from './nfcManager'
import { fixNfcPermissions } from './clients/nfcPermissionFix'
import { chooseCover, getCoverArt, searchCoverOptions } from './steamgriddb'
import {
  clearAllHeroicSessionEnv,
  getGameProton,
  listProtonBuilds,
  setGameProton
} from './clients/heroic'
import {
  enableSteamInputForGenericControllers,
  getSteamCompatTools,
  setSteamCompatTool,
  ensureSteamAutoAccept,
  waitForSteamCef
} from './clients/steamCef'
import { startLibraryWatcher } from './libraryWatcher'
import { getWineActivity, startWineMonitor } from './wineMonitor'

let gameIndex = new Map<string, UnifiedGame>()

function indexGames(games: UnifiedGame[]): void {
  gameIndex = new Map(games.map((g) => [g.id, g]))
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** The renderer locks itself while Wine is active, but this is the real gate - an
 *  action already in flight, or any path that bypasses the UI, must not be able to
 *  start an install/launch on top of a running Windows game either. */
function assertNoWineRunning(): void {
  if (getWineActivity().active) {
    throw new Error('A Wine/Proton game is running - close it first.')
  }
}

/** Installed Steam games - from the live index, or the on-disk cache right after startup
 *  before the first scan has populated it. */
async function installedSteamAppIds(): Promise<string[]> {
  const games = gameIndex.size > 0 ? [...gameIndex.values()] : await getCachedLibrary()
  return games.filter((g) => g.store === 'steam' && g.isInstalled).map((g) => g.appId)
}

async function doRefresh(): Promise<UnifiedGame[]> {
  const { games, warnings } = await refreshLibrary()
  indexGames(games)
  for (const warning of warnings) broadcast('app:warning', warning)
  return games
}

/** Ensures a plain, guaranteed-cloneable Error crosses the IPC boundary on failure. */
function safeHandle<Args extends unknown[], R>(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: Args) => Promise<R>
): void {
  ipcMain.handle(channel, async (event, ...args: Args) => {
    try {
      return await fn(event, ...args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`Error in IPC handler '${channel}':`, message)
      throw new Error(message)
    }
  })
}

export function registerIpcHandlers(): void {
  indexGames(getCachedLibrary())

  // Custom titlebar (App.tsx) button handlers - the renderer has no direct access to
  // BrowserWindow (sandboxed, no Node integration), so these are its only way to do
  // what the native frame's own minimize/maximize/close buttons used to do before
  // frame: false.
  safeHandle('window:minimize', async () => minimizeMainWindow())
  safeHandle('window:toggleMaximize', async () => toggleMaximizeMainWindow())
  safeHandle('window:setFullscreen', async (_e, on: boolean) => setMainWindowFullscreen(on))
  safeHandle('window:isMaximized', async () => isMainWindowMaximized())
  safeHandle('window:close', async () => closeMainWindow())

  safeHandle('detect:all', async () => detectAll())

  safeHandle('library:get', async () => getCachedLibrary())

  safeHandle('library:refresh', async () => doRefresh())

  safeHandle('settings:get', async () => loadSettings())

  safeHandle('settings:save', async (_e, patch: SettingsPatch) => {
    const saved = saveSettings(patch)
    // Apply a gamescope change to games' Steam launch options right away, not only on
    // their next launch from here.
    if ('useGamescope' in patch) void syncGamescopeLaunchOptions(await installedSteamAppIds())
    return saved
  })

  safeHandle('covers:get', async (_e, gameId: string) => {
    const settings = loadSettings()
    const game = gameIndex.get(gameId)
    // gameIndex can still be empty/stale right after startup (a real race, not
    // hypothetical - the same class of bug found in the NFC path) - resolved: false
    // tells the renderer this wasn't a genuine "no art" answer, so it's safe to retry
    // once the index is actually populated instead of caching a permanent blank.
    if (!game) return { cover: null, hero: null, resolved: false }
    const result = await getCoverArt(
      settings.steamGridDbApiKey,
      game.id,
      game.store,
      game.appId,
      game.title,
      { cover: game.coverUrl, hero: game.heroUrl }
    )
    return {
      cover: result.cover ? localCoverUrl(result.cover, result.version) : null,
      hero: result.hero ? localCoverUrl(result.hero, result.version) : null,
      resolved: result.resolved
    }
  })

  safeHandle('covers:search', async (_e, gameId: string) => {
    const settings = loadSettings()
    const game = gameIndex.get(gameId)
    if (!game || !settings.steamGridDbApiKey) return []
    return searchCoverOptions(settings.steamGridDbApiKey, game.store, game.appId, game.title)
  })

  safeHandle('covers:choose', async (_e, gameId: string, url: string) => {
    const result = await chooseCover(gameId, url)
    if (!result) throw new Error('Could not download that image.')
    return localCoverUrl(result.path, result.version)
  })

  safeHandle('game:install', async (_e, gameId: string) => {
    assertNoWineRunning()
    const game = gameIndex.get(gameId)
    if (!game) throw new Error('Unknown game')
    const { steam, heroic } = await getRuntimeDetections()
    const ctx: InstallCtx = { steam, heroic }
    const onProgress = (evt: InstallProgressEvent): void => broadcast('install:progress', evt)
    try {
      await installManager.install(game, ctx, onProgress)
    } finally {
      broadcast('library:updated', await doRefresh())
    }
  })

  safeHandle('game:cancelInstall', async (_e, gameId: string) => {
    const { steam } = await getRuntimeDetections()
    await installManager.cancel(gameId, steam)
  })

  safeHandle('compat:get', async (_e, gameId: string): Promise<CompatInfo> => {
    const game = gameIndex.get(gameId)
    const none: CompatInfo = { supported: false, current: '', options: [] }
    if (!game) return none
    const { steam, heroic } = await getRuntimeDetections()
    if (game.store === 'steam') {
      const info = await getSteamCompatTools(game.appId)
      if (!info) return none
      return {
        supported: true,
        current: info.current,
        options: [{ id: '', label: 'Default (Steam decides)' }, ...info.tools]
      }
    }
    // GOG/Epic/Amazon run Windows builds through Proton; a native Linux build can't.
    if (game.platform === 'linux') return none
    return {
      supported: true,
      current: getGameProton(heroic, game.appId) ?? '',
      options: [
        { id: '', label: 'Default (Heroic setting)' },
        ...listProtonBuilds(steam.root).map((b) => ({ id: b.name, label: b.name }))
      ]
    }
  })

  // The controller layer only runs for games launched without Steam - Steam games keep
  // Steam Input.
  safeHandle('input:getMode', async (_e, gameId: string): Promise<ControllerModeInfo | null> => {
    const game = gameIndex.get(gameId)
    if (!game || game.store === 'steam') return null
    const { mode, support } = await detectControllerMode(game)
    return {
      setting: getControllerMode(gameId),
      detected: mode,
      supported: support?.supported ?? null
    }
  })

  safeHandle('input:setMode', async (_e, gameId: string, setting: ControllerModeSetting) => {
    if (!['auto', 'gamepad', 'kbm'].includes(setting)) throw new Error('Unknown controller mode')
    setControllerMode(gameId, setting)
  })

  safeHandle('compat:set', async (_e, gameId: string, toolId: string) => {
    assertNoWineRunning()
    const game = gameIndex.get(gameId)
    if (!game) throw new Error('Unknown game')
    const { steam, heroic } = await getRuntimeDetections()
    if (game.store === 'steam') {
      if (!(await setSteamCompatTool(game.appId, toolId))) {
        throw new Error("Couldn't reach Steam to change its compatibility setting.")
      }
      return
    }
    const build = toolId ? listProtonBuilds(steam.root).find((b) => b.name === toolId) : null
    if (toolId && !build) throw new Error(`Proton build "${toolId}" not found`)
    setGameProton(heroic, game, build ?? null)
  })

  safeHandle('game:uninstall', async (_e, gameId: string) => {
    assertNoWineRunning()
    const game = gameIndex.get(gameId)
    if (!game) throw new Error('Unknown game')
    const { steam, heroic } = await getRuntimeDetections()
    const ctx: InstallCtx = { steam, heroic }
    const onProgress = (evt: InstallProgressEvent): void => broadcast('install:progress', evt)
    try {
      await installManager.uninstall(game, ctx, onProgress)
    } finally {
      broadcast('library:updated', await doRefresh())
    }
  })

  safeHandle('game:launch', async (_e, gameId: string) => {
    assertNoWineRunning()
    const game = gameIndex.get(gameId)
    if (!game) throw new Error('Unknown game')
    const { steam, heroic } = await getRuntimeDetections()
    const ctx: LaunchCtx = { steam, heroic }
    // running:true is sent immediately (see launchManager.ts), before any process
    // exists - the Play button already goes disabled/"Running…" for the whole launch
    // attempt, including a first Windows launch that has to fetch Proton-GE first.
    const onState = (evt: LaunchStateEvent): void => broadcast('launch:state', evt)
    void launchGame(game, ctx, onState)
  })

  safeHandle('shell:openPath', async (_e, path: string) => {
    await shell.openPath(path)
  })

  safeHandle('shell:openExternal', async (_e, url: string) => {
    await shell.openExternal(url)
  })

  safeHandle('auth:status', async (): Promise<StoreAuthStatus> => {
    const { heroic } = await getRuntimeDetections()
    return { gog: gogLoggedIn(heroic), epic: epicLoggedIn(heroic), amazon: amazonLoggedIn(heroic) }
  })

  safeHandle('auth:gog', async () => {
    const { heroic } = await getRuntimeDetections()
    await loginGog(heroic)
  })

  safeHandle('auth:epic', async () => {
    const { heroic } = await getRuntimeDetections()
    await loginEpic(heroic)
  })

  safeHandle('auth:amazon', async () => {
    const { heroic } = await getRuntimeDetections()
    await loginAmazon(heroic)
  })

  safeHandle('auth:logoutGog', async () => {
    const { heroic } = await getRuntimeDetections()
    logoutGog(heroic)
  })

  safeHandle('auth:logoutEpic', async () => {
    const { heroic } = await getRuntimeDetections()
    await logoutEpic(heroic)
  })

  safeHandle('auth:logoutAmazon', async () => {
    const { heroic } = await getRuntimeDetections()
    await logoutAmazon(heroic)
  })

  safeHandle('nfc:available', async () => isNfcAvailable())

  safeHandle('nfc:fixPermissions', async () => fixNfcPermissions())

  safeHandle('nfc:writeGame', async (_e, gameId: string) => {
    if (!gameIndex.has(gameId)) throw new Error('Unknown game')
    await writeGameToTag(gameId)
  })

  // Started once, here, rather than per-renderer-window: the watcher owns a single
  // long-lived serial connection for the app's whole lifetime, same as the tray icon.
  startNfcWatcher(
    (gameId) => {
      if (!gameIndex.has(gameId)) return
      // Showing the window would pop the launcher on top of the running game, and the
      // launch itself would be refused anyway - ignore the scan entirely.
      if (getWineActivity().active) return
      // The app normally sits hidden to the tray - without this, a scan would launch
      // the game and broadcast the tag-scanned event to a window nobody's looking at,
      // so our own "Launching…" overlay (and Steam's transient dialog on top of it)
      // would render behind everything instead of in front, indistinguishable from
      // Steam's popup "covering" the launcher.
      showMainWindow()
      broadcast('nfc:tagScanned', gameId)
      // A tag that doesn't match any known game (wiped, foreign, or from a game removed
      // from the library since) is silently ignored - there's nothing useful to launch.
    },
    (available) => broadcast('nfc:availabilityChanged', available),
    (message) => broadcast('app:warning', message)
  )

  // Steam is only for Steam games - it isn't started with OmniLauncher, only
  // when a Steam game is installed or played (both start it on demand). If it happens to
  // be running already, its settings are brought in line the same as before.
  void getRuntimeDetections()
    .then(async ({ steam, heroic }) => {
      // Controller settings left in Heroic's game configs by a session that never got to
      // finish (OmniLauncher closed mid-game) - they'd hide the controllers from that game
      // when it's started from Heroic itself.
      clearAllHeroicSessionEnv(heroic)
      // So whenever Steam next starts (from here, at login or by hand) it opens the port
      // the auto-accept/silent-install calls need - Decky isn't there to do it outside
      // Bazzite/SteamOS.
      enableSteamRemoteDebugging(steam)
      if (await waitForSteamCef(3000)) {
        await ensureSteamAutoAccept()
        // Steam Input for generic controllers (the 8BitDo isn't an Xbox/PlayStation pad) -
        // re-applied every start so all Steam games, and GOG games launched through Steam,
        // see it as a standard controller.
        await enableSteamInputForGenericControllers()
        await syncGamescopeLaunchOptions(await installedSteamAppIds())
      }
    })
    .catch(() => {})

  // Installs/uninstalls made in Steam or Heroic directly show up without a manual rescan,
  // and Steam downloads started there appear on the Downloads page.
  void getRuntimeDetections()
    .then(({ steam, heroic }) =>
      startLibraryWatcher({
        steam,
        heroic,
        isTracked: (gameId) => installManager.isBusy(gameId),
        isGameRunning: () => getWineActivity().active,
        onLibraryChanged: async () => broadcast('library:updated', await doRefresh()),
        onProgress: (evt) => broadcast('install:progress', evt)
      })
    )
    .catch(() => {})

  // The controller layer for OmniLauncher's own UI (see startUiInput).
  void getRuntimeDetections()
    .then(({ steam }) => startUiInput(steam.root, () => isSteamRunning(steam.variant)))
    .catch(() => {})

  safeHandle('wine:getActivity', async () => getWineActivity())
  startWineMonitor(
    (activity: WineActivity) => broadcast('wine:activity', activity),
    (gameId) => installManager.isWorkingOn(gameId)
  )
}
