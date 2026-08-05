import { BrowserWindow, ipcMain, shell } from 'electron'
import type {
  InstallProgressEvent,
  LaunchStateEvent,
  SettingsPatch,
  StoreAuthStatus,
  UnifiedGame
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
  showMainWindow,
  toggleMaximizeMainWindow
} from './index'
import { installManager, type RuntimeContext as InstallCtx } from './installManager'
import { launchGame, type RuntimeContext as LaunchCtx } from './launchManager'
import { detectAll, getCachedLibrary, getRuntimeDetections, refreshLibrary } from './library'
import { isNfcAvailable, startNfcWatcher, writeGameToTag } from './nfcManager'
import { fixNfcPermissions } from './clients/nfcPermissionFix'
import { chooseCover, getCoverArt, searchCoverOptions } from './steamgriddb'

let gameIndex = new Map<string, UnifiedGame>()

function indexGames(games: UnifiedGame[]): void {
  gameIndex = new Map(games.map((g) => [g.id, g]))
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
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
  safeHandle('window:isMaximized', async () => isMainWindowMaximized())
  safeHandle('window:close', async () => closeMainWindow())

  safeHandle('detect:all', async () => detectAll())

  safeHandle('library:get', async () => getCachedLibrary())

  safeHandle('library:refresh', async () => doRefresh())

  safeHandle('settings:get', async () => loadSettings())

  safeHandle('settings:save', async (_e, patch: SettingsPatch) => saveSettings(patch))

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
    installManager.cancel(gameId)
  })

  safeHandle('game:uninstall', async (_e, gameId: string) => {
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
    const game = gameIndex.get(gameId)
    if (!game) throw new Error('Unknown game')
    const { steam, heroic } = await getRuntimeDetections()
    const ctx: LaunchCtx = { steam, heroic }
    // running:true is sent immediately (see launchManager.ts), before any process
    // exists - the Play button already goes disabled/"Running…" for the whole launch
    // attempt, including a first Windows launch that has to fetch Proton-GE first.
    const onState = (evt: LaunchStateEvent): void => broadcast('launch:state', evt)
    // Reuses the same 'install:progress' channel the install flow already broadcasts on
    // (see installManager) purely so that download's lines land in consoleLog/progress
    // state the same way an install's do, for whenever the UI surfaces those.
    const onProgress = (evt: InstallProgressEvent): void => broadcast('install:progress', evt)
    void launchGame(game, ctx, onState, onProgress)
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
}
