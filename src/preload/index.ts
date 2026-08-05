import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppSettings,
  CoverOption,
  DetectionResult,
  InstallProgressEvent,
  LaunchStateEvent,
  NfcFixResult,
  SettingsPatch,
  StoreAuthStatus,
  UnifiedGame
} from '../shared/types'

const api = {
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke('window:toggleMaximize'),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  onWindowMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },
  detectAll: (): Promise<DetectionResult> => ipcRenderer.invoke('detect:all'),
  getLibrary: (): Promise<UnifiedGame[]> => ipcRenderer.invoke('library:get'),
  refreshLibrary: (): Promise<UnifiedGame[]> => ipcRenderer.invoke('library:refresh'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: SettingsPatch): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', patch),
  getCoverArt: (
    gameId: string
  ): Promise<{ cover: string | null; hero: string | null; resolved: boolean }> =>
    ipcRenderer.invoke('covers:get', gameId),
  searchCoverOptions: (gameId: string): Promise<CoverOption[]> =>
    ipcRenderer.invoke('covers:search', gameId),
  chooseCover: (gameId: string, url: string): Promise<string> =>
    ipcRenderer.invoke('covers:choose', gameId, url),
  installGame: (gameId: string): Promise<void> => ipcRenderer.invoke('game:install', gameId),
  cancelInstall: (gameId: string): Promise<void> =>
    ipcRenderer.invoke('game:cancelInstall', gameId),
  uninstallGame: (gameId: string): Promise<void> => ipcRenderer.invoke('game:uninstall', gameId),
  launchGame: (gameId: string): Promise<void> => ipcRenderer.invoke('game:launch', gameId),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  getAuthStatus: (): Promise<StoreAuthStatus> => ipcRenderer.invoke('auth:status'),
  loginGog: (): Promise<void> => ipcRenderer.invoke('auth:gog'),
  loginEpic: (): Promise<void> => ipcRenderer.invoke('auth:epic'),
  loginAmazon: (): Promise<void> => ipcRenderer.invoke('auth:amazon'),
  logoutGog: (): Promise<void> => ipcRenderer.invoke('auth:logoutGog'),
  logoutEpic: (): Promise<void> => ipcRenderer.invoke('auth:logoutEpic'),
  logoutAmazon: (): Promise<void> => ipcRenderer.invoke('auth:logoutAmazon'),
  isNfcAvailable: (): Promise<boolean> => ipcRenderer.invoke('nfc:available'),
  fixNfcPermissions: (): Promise<NfcFixResult> => ipcRenderer.invoke('nfc:fixPermissions'),
  writeGameToTag: (gameId: string): Promise<void> => ipcRenderer.invoke('nfc:writeGame', gameId),
  onNfcTagScanned: (cb: (gameId: string) => void): (() => void) => {
    const listener = (_e: unknown, gameId: string): void => cb(gameId)
    ipcRenderer.on('nfc:tagScanned', listener)
    return () => ipcRenderer.removeListener('nfc:tagScanned', listener)
  },
  onNfcAvailabilityChanged: (cb: (available: boolean) => void): (() => void) => {
    const listener = (_e: unknown, available: boolean): void => cb(available)
    ipcRenderer.on('nfc:availabilityChanged', listener)
    return () => ipcRenderer.removeListener('nfc:availabilityChanged', listener)
  },
  onInstallProgress: (cb: (evt: InstallProgressEvent) => void): (() => void) => {
    const listener = (_e: unknown, evt: InstallProgressEvent): void => cb(evt)
    ipcRenderer.on('install:progress', listener)
    return () => ipcRenderer.removeListener('install:progress', listener)
  },
  onLaunchState: (cb: (evt: LaunchStateEvent) => void): (() => void) => {
    const listener = (_e: unknown, evt: LaunchStateEvent): void => cb(evt)
    ipcRenderer.on('launch:state', listener)
    return () => ipcRenderer.removeListener('launch:state', listener)
  },
  onLibraryUpdated: (cb: (games: UnifiedGame[]) => void): (() => void) => {
    const listener = (_e: unknown, games: UnifiedGame[]): void => cb(games)
    ipcRenderer.on('library:updated', listener)
    return () => ipcRenderer.removeListener('library:updated', listener)
  },
  onWarning: (cb: (message: string) => void): (() => void) => {
    const listener = (_e: unknown, message: string): void => cb(message)
    ipcRenderer.on('app:warning', listener)
    return () => ipcRenderer.removeListener('app:warning', listener)
  }
}

export type OmniLauncherApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
