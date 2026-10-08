/** Variables the AppImage runtime adds that describe OmniLauncher's own bundle. */
const APPIMAGE_VARS = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']

/** Path lists the AppImage runtime may prepend its own mount (/tmp/.mount_...) to. */
const PATH_LISTS = [
  'PATH',
  'LD_LIBRARY_PATH',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'GSETTINGS_SCHEMA_DIR',
  'PYTHONPATH',
  'PERLLIB',
  'QT_PLUGIN_PATH',
  'GIO_MODULE_DIR',
  'GDK_PIXBUF_MODULEDIR',
  'GDK_PIXBUF_MODULE_FILE',
  'GST_PLUGIN_SYSTEM_PATH',
  'GST_PLUGIN_SYSTEM_PATH_1_0'
]

/**
 * The environment for anything OmniLauncher starts (Steam, umu, gogdl, legendary, nile):
 * process.env minus what the AppImage runtime injected for OmniLauncher itself. Passing it
 * through unchanged leaked LD_LIBRARY_PATH=/tmp/.mount_omnila.../usr/lib into Steam - which
 * OmniLauncher starts - and from there into every game, loading OmniLauncher's bundled
 * libraries ahead of the system's (and pointing at a mount that vanishes on quit).
 */
export function hostEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const appDir = env.APPDIR
  const isOurs = (p: string): boolean =>
    p.includes('/tmp/.mount_') || (!!appDir && p.startsWith(appDir))

  for (const key of APPIMAGE_VARS) delete env[key]
  // Set when OmniLauncher's own binary runs as plain Node - any Electron app it starts
  // (Heroic) would inherit it and exit on the spot.
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of PATH_LISTS) {
    const value = env[key]
    if (value === undefined) continue
    const kept = value.split(':').filter((p) => p && !isOurs(p))
    if (kept.length > 0) env[key] = kept.join(':')
    else delete env[key]
  }
  return { ...env, ...extra }
}
