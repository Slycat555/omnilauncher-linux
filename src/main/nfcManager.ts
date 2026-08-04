import { readdirSync } from 'fs'
import { Pn532 } from './clients/pn532'
import { getGameIdForTag, recordTagWrite } from './nfcTagsStore'

/**
 * Owns the single PN532 connection for the whole app. Auto-detects the serial device
 * (PN532 USB-serial dongles show up as a plain /dev/ttyUSB0 or /dev/ttyACM0, like any
 * other USB-UART adapter - there's no vendor-specific device class to filter on more
 * precisely without a specific dongle's USB vendor/product id, which varies by board).
 *
 * There is exactly one reader and one poll loop for the whole app's lifetime once
 * started - a PN532 only supports one exchange in flight over its single UART, so
 * write mode doesn't get its own connection or its own polling loop. It instead
 * piggybacks on the next 'tag' event the already-running watcher loop produces.
 */

let reader: Pn532 | null = null
let onScanCb: ((gameId: string) => void) | null = null
let onAvailabilityChangeCb: ((available: boolean) => void) | null = null
/** Set only while a write is pending, so writeGameToTag() can reject a second call
 *  instead of racing with the first - the actual pending state (which tag gets it) now
 *  lives inside the Pn532 instance itself via requestWrite(), since reads/writes happen
 *  deep inside its poll cycle where the port is open. */
let writePending = false
let pendingWriteGameId: string | null = null
let writeResolve: (() => void) | null = null
let writeReject: ((err: Error) => void) | null = null
/** Tracked so onAvailabilityChange only fires on a real transition - the reader's
 *  'status' event fires roughly once a second by design (each poll cycle fully
 *  reconnects, see pn532.ts), and broadcasting on every single one of those was
 *  triggering a store update - and a re-render of every game card - once a second even
 *  though nothing had actually changed. That's what was making the card menu glitch:
 *  a card re-rendering out from under an open, portal-rendered menu that was mid-write
 *  (waiting up to 15s for a tag tap) doesn't literally break anything, but felt like the
 *  UI "bugging out" during that whole window. */
let lastReportedAvailable: boolean | null = null
/** Set to the uid of a tag right after a successful write, cleared only once the
 *  reader reports that tag physically removed - writeGameToTag() refuses to start a
 *  new write while this is set, so writing the same still-present tag again (e.g. an
 *  accidental double-click) can't happen until it's actually lifted off the reader. */
let justWrittenUid: string | null = null

function findDevicePath(): string | null {
  try {
    const entries = readdirSync('/dev')
    const candidate = entries.find((e) => /^(ttyUSB|ttyACM)\d+$/.test(e))
    return candidate ? `/dev/${candidate}` : null
  } catch {
    return null
  }
}

export function isNfcAvailable(): boolean {
  return findDevicePath() !== null
}

let detectTimer: NodeJS.Timeout | null = null

/** Starts watching for tags. Safe to call more than once - later calls just replace the
 *  scan callback rather than opening a second connection. onScan fires with whatever
 *  text was read off a tag written by writeGameToTag() (the game's own id, nothing else
 *  is ever written there).
 *
 *  If the reader isn't plugged in yet at call time (or hasn't finished enumerating - a
 *  real race against app startup, not hypothetical) this used to give up permanently and
 *  silently leave NFC off for the rest of the app's lifetime with no way to recover short
 *  of restarting the app. It now keeps polling for the device node every few seconds
 *  until one shows up.
 *
 *  onAvailabilityChange fires whenever the reader actually finishes its handshake or
 *  drops, so the renderer's "Write to NFC tag" option can appear/disappear live instead
 *  of only reflecting whatever isNfcAvailable() returned once at app startup - which
 *  used to stay wrong (perpetually unavailable) for the whole session if the reader
 *  wasn't already plugged in and enumerated by the time the app launched. */
export function startNfcWatcher(
  onScan: (gameId: string) => void,
  onAvailabilityChange?: (available: boolean) => void
): void {
  onScanCb = onScan
  if (onAvailabilityChange) onAvailabilityChangeCb = onAvailabilityChange
  if (reader) return
  const path = findDevicePath()
  if (!path) {
    if (!detectTimer) {
      detectTimer = setInterval(() => {
        if (reader) {
          if (detectTimer) clearInterval(detectTimer)
          detectTimer = null
          return
        }
        const found = findDevicePath()
        if (found) {
          if (detectTimer) clearInterval(detectTimer)
          detectTimer = null
          startNfcWatcher(onScanCb!)
        }
      }, 3000)
    }
    return
  }

  reader = new Pn532(path)
  reader.on('status', (status) => {
    console.log(`[NFC] ${status} (${path})`)
    const available = status === 'connected'
    if (available !== lastReportedAvailable) {
      lastReportedAvailable = available
      onAvailabilityChangeCb?.(available)
    }
  })
  reader.on('handshake', (attempt, ok) => {
    console.log(`[NFC] handshake attempt ${attempt}: ${ok ? 'OK' : 'no response'}`)
  })
  reader.on('tag', (tag) => {
    console.log(`[NFC] tag detected, uid=${tag.uid}`)
    // Prefer the persisted uid -> gameId record (see nfcTagsStore.ts) over the tag's
    // own NDEF text: it's what makes a scan resolve reliably even if the NDEF decode
    // has a hiccup on a given read, and it's the actual "saved in a config" record of
    // what's been written, not just whatever happens to physically be on the tag right
    // now. Falls back to the NDEF text itself for tags written before this existed, or
    // written by something other than this app.
    const gameId = getGameIdForTag(tag.uid) ?? tag.text
    console.log(`[NFC] resolved uid ${tag.uid} -> ${gameId ?? '(no match)'}`)
    if (gameId) onScanCb?.(gameId)
  })
  reader.on('writeResult', (ok, uid, err) => {
    writePending = false
    if (ok) {
      if (pendingWriteGameId) recordTagWrite(uid, pendingWriteGameId)
      justWrittenUid = uid
      writeResolve?.()
    } else {
      writeReject?.(err ?? new Error('Write failed'))
    }
    pendingWriteGameId = null
    writeResolve = null
    writeReject = null
  })
  reader.on('tagRemoved', (uid) => {
    if (uid === justWrittenUid) justWrittenUid = null
  })
  // Pn532 handles reconnection internally now (this board can go unresponsive and come
  // back on its own, or need a fresh serial connection to recover - see pn532.ts) so a
  // transient error here should not tear down and null out the whole reader; it keeps
  // retrying against the same instance rather than requiring startNfcWatcher() to be
  // called again (which would need an app restart in practice, since it's only ever
  // called once at startup).
  reader.startPolling()
}

export function stopNfcWatcher(): void {
  if (detectTimer) clearInterval(detectTimer)
  detectTimer = null
  reader?.close()
  reader = null
  onScanCb = null
  writePending = false
  pendingWriteGameId = null
  justWrittenUid = null
  writeResolve = null
  writeReject = null
}

/** Writes the given game id to the next tag presented to the reader. Requires the
 *  watcher to already be running (it rides that poll loop's next tag detection rather
 *  than opening a second connection) - callers should check isNfcAvailable() /
 *  ensure startNfcWatcher() has run first. */
export function writeGameToTag(gameId: string): Promise<void> {
  if (!reader) {
    return Promise.reject(new Error('No NFC reader connected. Check the PN532 is plugged in.'))
  }
  if (writePending) {
    return Promise.reject(new Error('Already waiting for a tag - try again in a moment.'))
  }
  if (justWrittenUid) {
    return Promise.reject(
      new Error('That tag was just written - remove it from the reader before writing again.')
    )
  }
  writePending = true
  pendingWriteGameId = gameId
  reader.requestWrite(gameId)
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      writePending = false
      pendingWriteGameId = null
      reader?.cancelPendingWrite()
      writeResolve = null
      writeReject = null
      reject(new Error('No tag detected - hold a tag to the reader and try again.'))
    }, 15000)
    writeResolve = () => {
      clearTimeout(timeout)
      resolve()
    }
    writeReject = (err) => {
      clearTimeout(timeout)
      reject(err)
    }
  })
}
