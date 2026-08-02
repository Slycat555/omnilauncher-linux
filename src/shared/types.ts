export type StoreKind = 'steam' | 'epic' | 'gog' | 'amazon'

export type GamePlatform = 'windows' | 'linux' | 'mac'

export interface UnifiedGame {
  /** `${store}:${appId}` - stable unique id used everywhere in the UI */
  id: string
  store: StoreKind
  /** native id used by the backend CLI / URI for this store */
  appId: string
  title: string
  isInstalled: boolean
  isInstalling: boolean
  installPath?: string
  sizeOnDisk?: number
  installSizeBytes?: number
  coverUrl?: string
  heroUrl?: string
  logoUrl?: string
  description?: string
  genres?: string[]
  developer?: string
  playtimeMinutes?: number
  lastPlayed?: number
  platform?: GamePlatform
  canLaunch: boolean
  canInstall: boolean
  canUninstall: boolean
}

export type InstallPhase =
  | 'starting'
  | 'downloading'
  | 'installing'
  | 'done'
  | 'error'
  | 'cancelled'

export interface InstallProgressEvent {
  gameId: string
  phase: InstallPhase
  percent?: number
  /** Bytes transferred so far / in total, as reported by the backend CLI. */
  bytesDone?: number
  bytesTotal?: number
  speed?: string
  eta?: string
  message?: string
  raw?: string
}

export interface LaunchStateEvent {
  gameId: string
  running: boolean
  error?: string
}

export type ClientVariant = 'native' | 'flatpak' | null

export interface ClientStatus {
  present: boolean
  variant: ClientVariant
  detail?: string
}

export interface DetectionResult {
  steam: ClientStatus & { root: string | null }
  heroic: ClientStatus & {
    legendary: boolean
    gogdl: boolean
    nile: boolean
    configDir: string | null
  }
}

export interface AppSettings {
  steamGridDbApiKey: string
  steamWebApiKey: string
  steamId64: string
  defaultInstallBasePath: string
  /** Steam & GOG are always shown; Epic/Amazon are opt-in to keep the library focused. */
  enabledStores: {
    epic: boolean
    amazon: boolean
  }
  /** CSS zoom factor applied to the whole app shell - 1 is normal size, larger values
   *  make everything (text, cards, buttons) bigger for use on a TV from a distance. */
  uiScale: number
}

export interface SettingsPatch extends Partial<AppSettings> {}

export interface CoverOption {
  id: number
  url: string
  thumb: string
  width: number
  height: number
}

export interface StoreAuthStatus {
  gog: boolean
  epic: boolean
  amazon: boolean
}
