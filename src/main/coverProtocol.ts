import { net, protocol } from 'electron'
import { resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { coversCacheDir } from './paths'

const SCHEME = 'cover'

/** Must run before app.whenReady(). */
export function registerCoverProtocolPrivilege(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true }
    }
  ])
}

/**
 * Renderer <img> src for a locally-downloaded cover file. Serving through a registered
 * scheme (rather than a bare file:// URL) works the same in both `npm run dev` (renderer
 * served over http://localhost) and the packaged file:// build, and lets us validate the
 * path stays inside our own covers directory before touching disk.
 *
 * `version` must change whenever the file's contents change (we always download to a
 * fixed `cover.<ext>` name, so re-picking art overwrites the same path). Without a
 * version query, the URL string is byte-identical to before, so neither React nor
 * Chromium's HTTP cache have any signal to re-fetch it - the old image just stays put.
 */
export function localCoverUrl(absolutePath: string, version: number): string {
  return `${SCHEME}://local/${encodeURIComponent(absolutePath)}?v=${version}`
}

/** Must run after app.whenReady(). */
export function registerCoverProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'local') return new Response('Not found', { status: 404 })
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))

    const root = resolve(coversCacheDir()) + sep
    const resolved = resolve(filePath)
    if (!resolved.startsWith(root)) return new Response('Forbidden', { status: 403 })

    try {
      const res = await net.fetch(pathToFileURL(resolved).toString())
      // The file itself never expires by content, only by URL (the ?v= query) changing -
      // tell Chromium not to reuse a cached response across different versions.
      const headers = new Headers(res.headers)
      headers.set('Cache-Control', 'no-cache')
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
