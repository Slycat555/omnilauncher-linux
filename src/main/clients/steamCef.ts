/**
 * Talks to the Steam client's own UI JavaScript over its CEF remote-debugging port, to
 * call the same internal SteamClient.Installs API Steam's own install dialog uses.
 *
 * Only available when Steam was started with remote debugging enabled - the empty
 * `.cef-enable-remote-debugging` file in the Steam directory (the same switch Decky
 * Loader uses). Without it nothing listens on the port and every function here reports
 * "unavailable", so callers fall back to the normal steam://install dialog.
 */

const CEF_PORT = 8080

/** Install-manager states, from Steam's own EInstallMgrState enum (steamui JS). */
const STATE = {
  None: 0,
  FreeLicense: 3,
  ShowCDKey: 4,
  ShowPassword: 6,
  ShowConfig: 7,
  ShowEULAs: 8,
  ShowChangeMedia: 11,
  ShowSignup: 13,
  Complete: 14,
  Failed: 15,
  Canceled: 16
} as const

export type SteamAutoInstallResult =
  /** ContinueInstall() was called - the download is starting. */
  | { result: 'started' }
  /** Steam is asking for something only the user can type (CD key, password, account
   *  sign-up) - its dialog is left open. */
  | { result: 'needs-user'; reason: string }
  /** Cancelled inside Steam before starting. */
  | { result: 'cancelled' }
  /** Steam can't install it (e.g. not enough disk space) - the wizard is cancelled. */
  | { result: 'failed'; reason: string }
  /** No remote-debugging connection (flag not set, or Steam not restarted since). */
  | { result: 'unavailable' }

interface CefTarget {
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

/** The SharedJSContext target is where Steam's UI code (and the SteamClient global)
 *  lives - the same target Decky Loader injects into. */
async function findSharedContext(): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${CEF_PORT}/json`, {
      signal: AbortSignal.timeout(1500)
    })
    const targets = (await res.json()) as CefTarget[]
    const shared =
      targets.find((t) => t.title === 'SharedJSContext') ??
      targets.find((t) => /SharedJSContext|Steam Shared Context/i.test(t.title))
    return shared?.webSocketDebuggerUrl ?? null
  } catch {
    return null
  }
}

/** Runs one expression in Steam's UI context and returns its (JSON-serializable)
 *  value, awaiting it if it's a promise. */
export async function evaluateInSteam<T>(expression: string, timeoutMs: number): Promise<T | undefined> {
  const wsUrl = await findSharedContext()
  if (!wsUrl || typeof WebSocket === 'undefined') return undefined

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      resolve(undefined)
    }, timeoutMs)
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    }
    ws.onmessage = (msg) => {
      const data = JSON.parse(String(msg.data))
      if (data.id !== 1) return
      clearTimeout(timer)
      ws.close()
      resolve(data.result?.result?.value as T | undefined)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      resolve(undefined)
    }
  })
}

export async function steamCefAvailable(): Promise<boolean> {
  return (
    (await evaluateInSteam<boolean>(
      'typeof SteamClient?.Installs?.ContinueInstall === "function"',
      3000
    )) === true
  )
}

/**
 * Opens Steam's install wizard for `appId` and answers every question in it, so the
 * install runs with no dialog at all - mirroring the calls Steam's own dialogs make:
 *  - install confirmation (ShowConfig) and "add this free game" (FreeLicense):
 *    Installs.ContinueInstall()
 *  - each EULA (ShowEULAs): Apps.LoadEula() then Apps.MarkEulaAccepted() for every one,
 *    then ContinueInstall() - exactly Steam's own EULA workflow. The user asked for all
 *    EULAs to be accepted on their behalf.
 * Steam can show EULAs after the configure step, so after continuing it keeps answering
 * until the wizard closes. Not enough disk space fails cleanly (there's no "yes" that
 * works); CD key / password / sign-up prompts need typed input and are left to the user.
 */
export async function steamAutoInstall(appId: string): Promise<SteamAutoInstallResult> {
  const id = Number(appId)
  if (!Number.isInteger(id)) return { result: 'unavailable' }

  const script = `(async () => {
    const appId = ${id};
    return await new Promise((resolve) => {
      let done = false;
      let registration = null;
      let continued = false;
      let settle = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(settle);
        try { registration && registration.unregister(); } catch (e) {}
        resolve(value);
      };
      // After a ContinueInstall the wizard either closes (install running) or moves to
      // its next question; if nothing else arrives shortly, the install has started.
      const continueInstall = async () => {
        continued = true;
        clearTimeout(settle);
        await SteamClient.Installs.ContinueInstall();
        settle = setTimeout(() => finish({ result: 'started' }), 4000);
      };
      // Steam can fire this immediately with its current idle state, before our wizard
      // exists - None/Canceled only mean "the user cancelled" once our app has shown up.
      let seen = false;
      registration = SteamClient.Installs.RegisterForShowInstallWizard(async (w) => {
        if (!w) return;
        const ours = (w.rgApps || []).some((a) => a.nAppID === appId) || w.currentAppID === appId;
        if (ours) seen = true;
        if (!seen) return;
        const state = w.eInstallState;
        if (state === ${STATE.None} || state === ${STATE.Complete}) {
          return finish(continued ? { result: 'started' } : { result: 'cancelled' });
        }
        if (state === ${STATE.Canceled}) return finish({ result: 'cancelled' });
        if (state === ${STATE.Failed}) return finish({ result: 'failed', reason: 'Steam reported the install failed' });
        if (!ours) return;
        if (state === ${STATE.ShowConfig}) {
          if (w.nDiskSpaceRequired >= w.nDiskSpaceAvailable) {
            await SteamClient.Installs.CancelInstall();
            return finish({ result: 'failed', reason: 'Not enough disk space' });
          }
          return continueInstall();
        }
        if (state === ${STATE.FreeLicense}) return continueInstall();
        if (state === ${STATE.ShowEULAs}) {
          const eulas = (await SteamClient.Apps.LoadEula(w.currentAppID || appId)) || [];
          for (const eula of eulas) {
            await SteamClient.Apps.MarkEulaAccepted(w.currentAppID || appId, eula.id, eula.version);
          }
          return continueInstall();
        }
        if (state === ${STATE.ShowCDKey} || state === ${STATE.ShowPassword} || state === ${STATE.ShowSignup} || state === ${STATE.ShowChangeMedia}) {
          return finish({ result: 'needs-user', reason: 'Steam needs input' });
        }
      });
      SteamClient.Installs.OpenInstallWizard([appId]);
      setTimeout(() => finish(continued ? { result: 'started' } : { result: 'needs-user', reason: 'timeout' }), 45000);
    });
  })()`

  const value = await evaluateInSteam<SteamAutoInstallResult>(script, 50000)
  return value ?? { result: 'unavailable' }
}

/** Uninstalls with no confirmation dialog - OpenUninstallWizard(ids, true) is the call
 *  Steam's own Uninstall dialog makes once the user has clicked OK. */
export async function steamUninstall(appId: string): Promise<boolean> {
  const id = Number(appId)
  if (!Number.isInteger(id)) return false
  const script = `(() => { SteamClient.Installs.OpenUninstallWizard([${id}], true); return true; })()`
  return (await evaluateInSteam<boolean>(script, 10000)) === true
}

/** After a cold start Steam takes a while to bring its UI context (and with it the
 *  install API) up - wait for it rather than falling back to a dialog. */
export async function waitForSteamCef(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await steamCefAvailable()) return true
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/**
 * Cancels an install inside Steam the same way Steam's own UI does, so cancelling in
 * OmniLauncher actually stops the download instead of just hiding it:
 *  - `wizardOnly`: the install never started (Steam's dialog is still up) - just cancel
 *    the wizard (Installs.CancelInstall, what the dialog's Cancel button calls).
 *  - otherwise: remove it from the download queue (Downloads.RemoveFromDownloadList,
 *    the Downloads page's remove button; "0" is the local client) and, for a fresh
 *    install only, delete the partial files via OpenUninstallWizard(ids, true) - what
 *    Steam's own Uninstall confirmation calls. Never used for an update to an installed
 *    game: that would uninstall the whole game.
 * Returns false when Steam's remote debugging isn't available.
 */
export async function steamCancelInstall(
  appId: string,
  opts: { wizardOnly: boolean; removePartialFiles: boolean }
): Promise<boolean> {
  const id = Number(appId)
  if (!Number.isInteger(id)) return false
  const script = `(async () => {
    const appId = ${id};
    if (${opts.wizardOnly}) {
      await SteamClient.Installs.CancelInstall();
      return true;
    }
    try { await SteamClient.Downloads.RemoveFromDownloadList(appId, "0"); } catch (e) {}
    if (${opts.removePartialFiles}) SteamClient.Installs.OpenUninstallWizard([appId], true);
    return true;
  })()`
  return (await evaluateInSteam<boolean>(script, 10000)) === true
}

/**
 * Makes Steam answer its own pre-launch questions, so a launch never sits waiting on a
 * dialog nobody can see (Steam runs headless - its windows are minimized). Registers one
 * listener inside Steam's UI context for the session (idempotent: a flag on Steam's own
 * window object means re-calling it is a no-op until Steam restarts).
 *
 * Each answer is exactly what that dialog's confirm button sends in Steam's own UI
 * (steamui OnGameActionUserRequest): EULAs are accepted first, the first launch option is
 * picked, a session on another device is ended. Cloud-save conflicts are deliberately NOT
 * answered - picking a side automatically can overwrite saves - so that dialog still shows.
 */
export async function ensureSteamAutoAccept(): Promise<boolean> {
  const script = `(() => {
    // Versioned: a handler left registered by an older OmniLauncher (Steam keeps running
    // across launcher updates) is swapped for this one.
    const VERSION = 3;
    if (window.__omniLauncherAutoAcceptVersion === VERSION) return true;
    try { window.__omniLauncherAutoAccept?.unregister?.(); } catch (e) {}
    try { window.__omniLauncherActionStart?.unregister?.(); } catch (e) {}
    window.__omniLauncherAutoAcceptVersion = VERSION;
    // The user-request callback's second argument isn't the action id - Steam's own UI
    // answers with the id it got when the action started, so track those per game.
    const actions = new Map();
    window.__omniLauncherActionStart = SteamClient.Apps.RegisterForGameActionStart(
      (actionId, gameId) => actions.set(String(gameId), actionId)
    );
    window.__omniLauncherAutoAccept = SteamClient.Apps.RegisterForGameActionUserRequest(
      async (gameId, second, request, detail) => {
        const actionId = actions.get(String(gameId)) ?? second;
        const go = (value) => SteamClient.Apps.ContinueGameAction(actionId, value);
        const appId = parseInt(gameId);
        try {
          switch (request) {
            case 'ShowEula': {
              const eulas = (await SteamClient.Apps.LoadEula(appId)) || [];
              for (const eula of eulas) await SteamClient.Apps.MarkEulaAccepted(appId, eula.id, eula.version);
              return go(request);
            }
            case 'ShowInterstitials':
            case 'ShowGameArgs':
            case 'CreatingProcess':
              return go(request);
            case 'ShowDurationControl':
            case 'ShowCDKey':
              return go('');
            case 'KickingOtherSession':
              return go('KickOtherSession');
            case 'ShowLaunchOption':
              return go('0');
            // Steam Cloud / controller-config sync trouble before launch - answered the way
            // Steam's own dialog's "Play anyway" does: play without syncing, which changes
            // neither the local nor the cloud saves (a conflict is left for Steam to offer
            // again next time, never resolved by guessing a side).
            case 'SynchronizingCloud':
            case 'SynchronizingControllerConfig':
              if (detail === 'pendingcloudsessions') return go('IgnorePendingCloudSessions');
              return go('IgnoreCloud');
            default:
              // Anything else Steam stops to ask: carry on, as its own "continue" does.
              return go(request);
          }
        } catch (e) {}
      }
    );
    return true;
  })()`
  return (await evaluateInSteam<boolean>(script, 8000)) === true
}

export interface SteamShortcut {
  /** 32-bit shortcut app id - what Steam's reaper process is tagged with (AppId=...). */
  appId: number
  /** 64-bit game id - what steam://rungameid/ takes for a non-Steam shortcut. */
  gameId: string
}

/**
 * Creates (or updates in place) a non-Steam shortcut, so a game OmniLauncher launches goes
 * through Steam and gets Steam Input - Steam only applies Steam Input to games it launches
 * itself. AddShortcut ignores the name it's given (it names the shortcut after the exe;
 * verified), so every field is set explicitly afterwards. An existing shortcut is reused
 * when Steam still has it, so the game keeps one entry in the Steam library.
 */
export async function ensureSteamShortcut(s: {
  existingAppId?: number
  name: string
  exe: string
  startDir: string
  launchOptions: string
}): Promise<SteamShortcut | null> {
  const j = JSON.stringify
  const script = `(async () => {
    let id = ${Number(s.existingAppId) || 0};
    if (!id || !appStore.GetAppOverviewByAppID(id)) {
      id = await SteamClient.Apps.AddShortcut(${j(s.name)}, ${j(s.exe)}, ${j(s.startDir)}, ${j(s.launchOptions)});
    }
    SteamClient.Apps.SetShortcutName(id, ${j(s.name)});
    SteamClient.Apps.SetShortcutExe(id, ${j(s.exe)});
    SteamClient.Apps.SetShortcutStartDir(id, ${j(s.startDir)});
    SteamClient.Apps.SetShortcutLaunchOptions(id, ${j(s.launchOptions)});
    // Steam Input defaults to OFF for non-Steam shortcuts (Steam loads its empty layout and
    // passes the raw controller through) - force it on, the way the game's Properties ->
    // Controller -> "Enable Steam Input" does (EThirdPartyControllerConfiguration 2 = on).
    SteamClient.Apps.SetThirdPartyControllerConfiguration(id, 2);
    for (let i = 0; i < 20; i++) {
      const o = appStore.GetAppOverviewByAppID(id);
      if (o) return { appId: id, gameId: String(o.m_gameid) };
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  })()`
  return (await evaluateInSteam<SteamShortcut | null>(script, 15000)) ?? null
}

/** Turns on Steam Input for generic controllers (Steam → Settings → Controller) - Steam's
 *  SetSetting takes a serialized CMsgClientSettings; field 14007 is controller_generic_support
 *  (bool), so the message is just that field set to true: bytes b8 eb 06 01. */
export async function enableSteamInputForGenericControllers(): Promise<boolean> {
  const value = await evaluateInSteam<string>(
    `SteamClient.Settings.SetSetting("uOsGAQ==").then(() => "ok")`,
    8000
  )
  return value === 'ok'
}

/** A Steam game's custom launch options (Properties -> General -> Launch options), or null
 *  if Steam didn't answer - callers must not overwrite options they couldn't read. */
export async function getSteamLaunchOptions(appId: string): Promise<string | null> {
  const id = Number(appId)
  if (!Number.isInteger(id)) return null
  const script = `new Promise((resolve) => {
    let done = false;
    const handle = SteamClient.Apps.RegisterForAppDetails(${id}, (details) => {
      if (done) return;
      done = true;
      try { handle.unregister(); } catch (e) {}
      resolve(typeof details?.strLaunchOptions === 'string' ? details.strLaunchOptions : null);
    });
    setTimeout(() => { if (!done) { done = true; try { handle.unregister(); } catch (e) {} resolve(null); } }, 4000);
  })`
  const value = await evaluateInSteam<string | null>(script, 6000)
  return typeof value === 'string' ? value : null
}

export async function setSteamLaunchOptions(appId: string, options: string): Promise<boolean> {
  const id = Number(appId)
  if (!Number.isInteger(id)) return false
  return (
    (await evaluateInSteam<boolean>(
      `(() => { SteamClient.Apps.SetAppLaunchOptions(${id}, ${JSON.stringify(options)}); return true; })()`,
      5000
    )) === true
  )
}

export async function setSteamShortcutLaunchOptions(
  appId: number,
  options: string
): Promise<boolean> {
  return (
    (await evaluateInSteam<boolean>(
      `(() => { SteamClient.Apps.SetShortcutLaunchOptions(${Number(appId)}, ${JSON.stringify(options)}); return true; })()`,
      5000
    )) === true
  )
}

export interface CompatToolInfo {
  id: string
  label: string
}

/** A Steam game's Proton choice and the versions Steam offers for it (Properties ->
 *  Compatibility). `current` is "" when no compatibility tool is forced. */
export async function getSteamCompatTools(
  appId: string
): Promise<{ current: string; tools: CompatToolInfo[] } | null> {
  const id = Number(appId)
  if (!Number.isInteger(id)) return null
  const script = `(async () => {
    const tools = (await SteamClient.Apps.GetAvailableCompatTools(${id})) || [];
    const current = await new Promise((resolve) => {
      let done = false;
      const handle = SteamClient.Apps.RegisterForAppDetails(${id}, (d) => {
        if (done) return;
        done = true;
        try { handle.unregister(); } catch (e) {}
        resolve((d && d.strCompatToolName) || '');
      });
      setTimeout(() => { if (!done) { done = true; resolve(''); } }, 4000);
    });
    return { current, tools: tools.map((t) => ({ id: t.strToolName, label: t.strDisplayName })) };
  })()`
  return (await evaluateInSteam<{ current: string; tools: CompatToolInfo[] }>(script, 8000)) ?? null
}

/** Forces a compatibility tool for a Steam game, or clears it with "". */
export async function setSteamCompatTool(appId: string, tool: string): Promise<boolean> {
  const id = Number(appId)
  if (!Number.isInteger(id)) return false
  return (
    (await evaluateInSteam<boolean>(
      `(() => { SteamClient.Apps.SpecifyCompatTool(${id}, ${JSON.stringify(tool)}); return true; })()`,
      5000
    )) === true
  )
}
