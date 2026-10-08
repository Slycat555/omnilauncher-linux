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
  /** Real bytes downloaded / to download, when the backend reports them (Steam's
   *  manifest, or the "Downloaded: X MiB" line legendary/gogdl/nile print). Unlike
   *  bytesDone/bytesTotal, never a chunk count. */
  downloadedBytes?: number
  totalBytes?: number
  /** Current network download speed in bytes/second, as reported by the backend. */
  speedBps?: number
  /** A download OmniLauncher didn't start (begun in Steam directly) - the Downloads page
   *  creates an entry for it on its first progress event. */
  external?: boolean
}

export interface LaunchStateEvent {
  gameId: string
  running: boolean
  error?: string
}

/** Whether a game is running anywhere on the system (launched from here, Steam or Heroic;
 *  native or under Wine/Proton) - the UI is locked for as long as this is active. */
export interface WineActivity {
  active: boolean
  /** Library ids of the running games ("steam:123", "gog:456"), or "unknown" for a game
   *  that can't be matched to the library - shown by title, never by process name. */
  gameIds: string[]
}

/** A game's Proton choice and the builds that can be picked (game options panel). The
 *  option with id "" is "Default" - no forced tool. */
export interface CompatInfo {
  supported: boolean
  current: string
  options: { id: string; label: string }[]
}

/** How OmniLauncher's own controller layer presents controllers to a non-Steam game:
 *  as an Xbox 360 pad, or as keyboard + mouse for games with no controller support. */
export type ControllerMode = 'gamepad' | 'kbm'

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
  /** Steam & GOG are always shown; Epic/Amazon are opt-in to keep the library focused. */
  enabledStores: {
    epic: boolean
    amazon: boolean
  }
  /** CSS zoom factor applied to the whole app shell - 1 is normal size, larger values
   *  make everything (text, cards, buttons) bigger for use on a TV from a distance. */
  uiScale: number
  /** Open straight into fullscreen Big Picture mode on launch (couch/TV setups). */
  startInBigPicture: boolean
  /** Desktop mode only: run every game inside a nested gamescope, fullscreen at the
   *  monitor's native resolution and maximum refresh rate. Off by default, like the Steam
   *  Deck's desktop mode - Steam Input can't route a controller into a nested gamescope.
   *  Inside a gamescope session (Game Mode) games are in gamescope already. */
  useGamescope: boolean
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

export interface NfcFixResult {
  ok: boolean
  message: string
}
