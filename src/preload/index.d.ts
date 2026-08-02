import { ElectronAPI } from '@electron-toolkit/preload'
import type { OmniLauncherApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: OmniLauncherApi
  }
}
