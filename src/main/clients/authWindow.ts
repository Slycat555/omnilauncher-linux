import { BrowserWindow } from 'electron'

/**
 * Runs a store login inside an app-controlled window instead of the system browser, so
 * the resulting authorization code can be read straight off the redirect instead of
 * asking the user to copy/paste it. The three stores need different extraction logic:
 *   - GOG: redirects to embed.gog.com/on_login_success?...&code=<CODE>
 *   - Amazon: redirects to amazon.com/...?openid.oa2.authorization_code=<CODE>&...
 *   - Epic: never redirects with a code in the URL - after login it lands on
 *     localhost/launcher/authorized?code=... (a URL nothing is listening on, since
 *     that's a leftover from Epic's actual desktop launcher, not this flow) whose body
 *     is plain JSON containing "authorizationCode". Read from the page content, not the
 *     URL, since the exact landing host isn't the stable part of this one.
 */

export type CodeExtractor = (url: string) => string | null

function openLoginWindow(startUrl: string, extract: CodeExtractor): Promise<string> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      autoHideMenuBar: true,
      webPreferences: { sandbox: true }
    })

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
      if (!win.isDestroyed()) win.close()
    }

    const checkUrl = (url: string): void => {
      const code = extract(url)
      if (code) finish(() => resolve(code))
    }

    // Covers a server-side redirect (Location header, before any page loads) as well as
    // a client-side one (JS navigation after the page has already loaded) - GOG and
    // Amazon each do it differently at different points in their flow.
    win.webContents.on('will-redirect', (_e, url) => checkUrl(url))
    win.webContents.on('did-navigate', (_e, url) => checkUrl(url))
    win.webContents.on('did-navigate-in-page', (_e, url) => checkUrl(url))

    win.on('closed', () => {
      finish(() => reject(new Error('Login window was closed before finishing.')))
    })

    win.loadURL(startUrl).catch((err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    })
  })
}

function extractQueryParam(url: string, param: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.searchParams.get(param)
  } catch {
    return null
  }
}

export function loginGogWindow(startUrl: string): Promise<string> {
  return openLoginWindow(startUrl, (url) => {
    if (!url.startsWith('https://embed.gog.com/on_login_success')) return null
    return extractQueryParam(url, 'code')
  })
}

export function loginAmazonWindow(startUrl: string): Promise<string> {
  return openLoginWindow(startUrl, (url) => {
    if (!url.startsWith('https://www.amazon.com/') && !url.startsWith('https://amazon.com/')) return null
    return extractQueryParam(url, 'openid.oa2.authorization_code')
  })
}

/**
 * Epic's flow: legendary.gl/epiclogin passes through a Cloudflare check, redirects into
 * epicgames.com for the actual login, then lands back on legendary.gl/epiclogin with the
 * authorization JSON rendered as the page's own text content - so this waits for
 * navigation to settle there and reads the DOM instead of a URL param.
 */
export function loginEpicWindow(startUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      autoHideMenuBar: true,
      webPreferences: { sandbox: true }
    })

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
      if (!win.isDestroyed()) win.close()
    }

    // Try on every load/redirect regardless of host - the Cloudflare/login steps along
    // the way just fail JSON.parse harmlessly and get skipped, so there's no need to
    // pin this to one exact URL (which turned out not to be legendary.gl at all - the
    // real landing page is localhost/launcher/authorized).
    const tryReadCode = async (): Promise<void> => {
      if (settled || win.isDestroyed()) return
      try {
        const text = (await win.webContents.executeJavaScript(
          'document.body.innerText'
        )) as string
        const parsed = JSON.parse(text.trim()) as { authorizationCode?: string }
        if (parsed.authorizationCode) finish(() => resolve(parsed.authorizationCode as string))
      } catch {
        // not the JSON page yet - the next navigation/load event will try again
      }
    }

    win.webContents.on('did-navigate', () => void tryReadCode())
    win.webContents.on('did-navigate-in-page', () => void tryReadCode())
    win.webContents.on('did-finish-load', () => void tryReadCode())
    // localhost/launcher/authorized is a URL nothing actually serves - Chromium may
    // report the navigation as "failed" even though the JSON body it captured along the
    // way is exactly what's needed, so this has to try reading the page too, not just
    // treat a load failure as fatal.
    win.webContents.on('did-fail-load', () => void tryReadCode())

    win.on('closed', () => {
      finish(() => reject(new Error('Login window was closed before finishing.')))
    })

    win.loadURL(startUrl).catch((err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    })
  })
}
