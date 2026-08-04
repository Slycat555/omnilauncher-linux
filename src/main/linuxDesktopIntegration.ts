import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, chmodSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'

/**
 * AppImages have no installed .desktop file by default - there's no AppImageLauncher/
 * appimaged daemon here to register one, so the desktop environment's taskbar has
 * nothing to look up "pin to taskbar" against even though the running window's
 * WM_CLASS is correct. This installs one into the user's own applications dir the
 * same way AppImageLauncher would.
 */
export function installLinuxDesktopEntry(): void {
  if (process.platform !== 'linux') return
  const runningAppImagePath = process.env.APPIMAGE
  if (!runningAppImagePath) return // not running as an AppImage (e.g. dev mode) - nothing to do

  const dataHome = process.env.XDG_DATA_HOME || join(app.getPath('home'), '.local', 'share')
  const desktopDir = join(dataHome, 'applications')
  const appDir = join(dataHome, 'omnilauncher') // not a themed icons/ dir - icon lives here too
  const desktopPath = join(desktopDir, 'omnilauncher-linux.desktop')
  const iconPath = join(appDir, 'omnilauncher-linux.png')
  // Stable, app-owned copy of the AppImage itself, not wherever the user happened to
  // save the download (~/Downloads, a USB stick, wherever a browser puts it). Confirmed
  // as a real cause of "pinned launcher sometimes just fails with an error sound and no
  // dialog" - a previous version of this pointed Exec= directly at $APPIMAGE, so the pin
  // silently broke the moment that exact file was moved, renamed, or replaced (e.g. a
  // browser saving a newer download under a different filename, or a "clean up
  // Downloads" pass) - KDE's Task Manager has no fallback for a missing Exec= target,
  // it just fails to launch with no visible error.
  const stableAppImagePath = join(appDir, 'omnilauncher-linux.AppImage')

  try {
    mkdirSync(appDir, { recursive: true })

    // Re-copy whenever the running AppImage differs from the stable copy (a new
    // version was launched from somewhere), not just once - keeps the pin's target
    // current across updates without ever depending on the original download's path
    // surviving. Compared by size+mtime rather than always re-copying a ~100MB+ file
    // unconditionally on every single launch.
    const runningStat = statSync(runningAppImagePath)
    const stableStat = existsSync(stableAppImagePath) ? statSync(stableAppImagePath) : null
    const needsCopy =
      !stableStat ||
      stableStat.size !== runningStat.size ||
      stableStat.mtimeMs !== runningStat.mtimeMs
    if (needsCopy) {
      copyFileSync(runningAppImagePath, stableAppImagePath)
      chmodSync(stableAppImagePath, 0o755)
    }

    const bundledIcon = join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'omni.png')
    if (existsSync(bundledIcon)) copyFileSync(bundledIcon, iconPath)

    // Icon= by theme name only resolves after a gtk-update-icon-cache refresh, which
    // nothing here triggers - that's what made the taskbar icon show up blank/broken.
    // An absolute path bypasses icon-theme/cache lookup entirely and every DE honors it
    // directly, at the cost of not respecting the user's icon theme (acceptable here).
    const desktopEntry = `[Desktop Entry]
Name=OmniLauncher
Comment=Unified game launcher for Steam and Heroic (GOG/Epic/Amazon)
Exec=${stableAppImagePath} --no-sandbox %U
Terminal=false
Type=Application
Icon=${iconPath}
StartupWMClass=omnilauncher-linux
Categories=Game;
`

    if (!existsSync(desktopPath) || readFileSync(desktopPath, 'utf-8') !== desktopEntry) {
      mkdirSync(desktopDir, { recursive: true })
      writeFileSync(desktopPath, desktopEntry)

      // KDE's Task Manager resolves pinned launchers against its own ksycoca cache of
      // installed .desktop files, not by re-reading the file live - without this, a
      // freshly written/updated entry (icon path, Exec, etc) doesn't show up until
      // something else happens to trigger a rescan.
      for (const bin of ['kbuildsycoca6', 'kbuildsycoca5']) {
        execFile(bin, ['--noincremental'], () => {})
      }
    }
  } catch (err) {
    console.error('[desktop-integration] failed to install .desktop entry:', err)
  }
}
