import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'

/**
 * AppImages have no installed .desktop file by default - there's no AppImageLauncher/
 * appimaged daemon here to register one, so the desktop environment's taskbar has
 * nothing to look up "pin to taskbar" against even though the running window's
 * WM_CLASS is correct. This installs one into the user's own applications dir the
 * same way AppImageLauncher would, pointed directly at $APPIMAGE - the real on-disk
 * path of whatever .AppImage file the user actually launched (set by the AppImage
 * runtime itself, not something derived or copied). If that exact file is later moved
 * or deleted the pin will need re-launching once to pick up the new path - that's a
 * deliberate tradeoff the user asked for over an earlier version of this that copied
 * the AppImage into an app-owned stable location instead.
 */
export function installLinuxDesktopEntry(): void {
  if (process.platform !== 'linux') return
  const appImagePath = process.env.APPIMAGE
  if (!appImagePath) return // not running as an AppImage (e.g. dev mode) - nothing to do

  const dataHome = process.env.XDG_DATA_HOME || join(app.getPath('home'), '.local', 'share')
  const desktopDir = join(dataHome, 'applications')
  const iconDir = join(dataHome, 'omnilauncher') // not a themed icons/ dir - see below
  const desktopPath = join(desktopDir, 'omnilauncher-linux.desktop')
  const iconPath = join(iconDir, 'omnilauncher-linux.png')

  // Icon= by theme name only resolves after a gtk-update-icon-cache refresh, which
  // nothing here triggers - that's what made the taskbar icon show up blank/broken.
  // An absolute path bypasses icon-theme/cache lookup entirely and every DE honors it
  // directly, at the cost of not respecting the user's icon theme (acceptable here).
  const desktopEntry = `[Desktop Entry]
Name=OmniLauncher
Comment=Unified game launcher for Steam and Heroic (GOG/Epic/Amazon)
Exec=${appImagePath} --no-sandbox %U
Terminal=false
Type=Application
Icon=${iconPath}
StartupWMClass=omnilauncher-linux
Categories=Game;
`

  try {
    mkdirSync(iconDir, { recursive: true })
    const bundledIcon = join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'omni.png')
    if (existsSync(bundledIcon)) copyFileSync(bundledIcon, iconPath)

    // Re-write on every launch (not just once) so a change in AppImage path - e.g. the
    // user moved/renamed it, or updated to a new file - stays in sync automatically the
    // next time it's launched from its new location.
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
