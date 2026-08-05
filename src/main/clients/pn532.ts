import { SerialPort } from 'serialport'
import { EventEmitter } from 'events'

/**
 * Minimal PN532 UART driver - just enough to detect a Type 2 tag (MIFARE
 * Ultralight/NTAG213/215/216, the common "blank NFC tag" family) and read/write a short
 * NDEF text payload to it. No existing npm package fit: nfc-pcsc needs a PC/SC (CCID)
 * reader, but a PN532 wired through a USB-serial adapter (CH340/FTDI) is plain UART, not
 * CCID - pcscd never sees it. pn532.js targets Web Serial/Web Bluetooth (browser APIs),
 * not Node's serial port. So this talks the documented PN532 UART frame protocol
 * directly: https://www.nxp.com/docs/en/user-guide/141520.pdf
 *
 * Some cheap PN532 boards (confirmed on the hardware this was built against) are
 * genuinely unreliable about power/reset - they can go completely unresponsive on the
 * UART for no software-visible reason and only come back after being unplugged and
 * replugged, or just spontaneously after a while. No amount of protocol-level retrying
 * fixes a board that has actually lost power, so this class is built to tolerate that:
 * init() retries indefinitely instead of giving up after one failed attempt, and the
 * poll loop detects a run of consecutive failures and does a full reconnect (close +
 * reopen the OS-level serial port + re-init) rather than silently polling a dead link
 * forever. This can't force a board back to life, but it means the app recovers on its
 * own the moment the board does, with no restart needed.
 *
 * The reference Python implementation (nfcpy) does NOT reopen its connection on every
 * single poll - `clf.connect(rdwr=...)` opens once and polls repeatedly against that
 * one open connection until a tag shows up, only closing after a full read-then-removal
 * cycle. An earlier version of this driver closed and reopened the serial port on every
 * single poll attempt, which was a misreading of nfcpy's actual behavior: it made every
 * scan pay the full USB/serial handshake cost (SAMConfiguration, RF config, etc.) on
 * every single tick, and closing mid-poll (including firing PowerDown right as a poll
 * might be in flight) could plausibly cause exactly the "keeps killing itself while
 * scanning" symptom that motivated fixing this. This now matches nfcpy's real shape:
 * connect once, poll on the same open connection continuously, and only tear down and
 * reconnect when a real failure streak is detected (consecutive no-response polls) -
 * not preemptively on every tag check.
 *
 * This still mirrors nfcpy's actual transport and chipset behavior where it matters for
 * correctness (nfc/clf/transport.py's TTY class and nfc/clf/pn532.py), having found and
 * fixed three real divergences by reading nfcpy's source directly:
 *
 * 1. nfcpy flushes the input buffer immediately before every single write
 *    (`tty.flushInput()` in `TTY.write`). Without this, stale bytes left over from a
 *    previous cut-short exchange (confirmed present via a raw byte-level test against
 *    the hardware) desync every parse afterward, even with the board behaving
 *    correctly.
 * 2. nfcpy's init() sends a 10-byte all-zero preamble before the first command, not a
 *    guessed 20-byte 0x55 wakeup burst.
 * 3. Every PN532 reply starts with a fixed 6-byte ACK frame (00 00 FF 00 FF 00) sent
 *    separately before the actual response frame - parsing must skip it explicitly
 *    rather than mistaking its own embedded 00 FF marker for the response.
 */

const PREAMBLE = 0x00
const START1 = 0x00
const START2 = 0xff
const HOST_TO_PN532 = 0xd4
const PN532_TO_HOST = 0xd5

// Commands used
const CMD_SAMCONFIGURATION = 0x14
const CMD_INLISTPASSIVETARGET = 0x4a
const CMD_INDATAEXCHANGE = 0x40
const CMD_POWERDOWN = 0x16
const CMD_RFCONFIGURATION = 0x32

// PowerDown wakeup-source bitmask, matching nfcpy's power_down_wakeup_src index for
// "HSU" (the UART itself) - bit 4. Any traffic on the UART wakes the chip back up.
const POWERDOWN_WAKEUP_HSU = 0b00010000

// MIFARE Ultralight/NTAG commands, sent via InDataExchange
const MF_READ = 0x30
const MF_WRITE = 0xa2 // 4-byte page write, the granularity these tags use

const PAGE_SIZE = 4
const NDEF_START_PAGE = 4 // pages 0-3 are UID/lock/capability on NTAG21x
const USABLE_PAGES = 36 // conservative floor common to NTAG213 (36 usable * 4B = 144B)

export interface NfcTag {
  uid: string
}

function frame(payload: number[]): Buffer {
  const len = payload.length
  const lcs = (~len + 1) & 0xff
  let dcs = 0
  for (const b of payload) dcs += b
  dcs = (~dcs + 1) & 0xff
  return Buffer.from([PREAMBLE, START1, START2, len, lcs, ...payload, dcs, 0x00])
}

const ACK_FRAME = Buffer.from([0x00, 0x00, 0xff, 0x00, 0xff, 0x00])

/** Every command the PN532 accepts gets a fixed 6-byte ACK frame (00 00 FF 00 FF 00)
 *  written back essentially immediately, followed *separately* by the actual response
 *  frame - they are not one frame. The previous version of this function searched for
 *  the first 00 FF marker and treated whatever followed as the response, which found
 *  the ACK frame's own 00 FF (at offset 1) and parsed its zero-length body as "the
 *  response" - reliably misreading every single reply as empty/invalid. This is why
 *  the handshake was failing 100% of the time even though the board was answering
 *  correctly the whole time (confirmed via nfcpy connecting to the same device
 *  successfully at the same moment this drove was reporting "no response").
 *
 *  Skips a leading ACK frame if present, then parses the real response frame that
 *  follows it - everything between the TFI and the checksum. Returns null if nothing
 *  valid was found. */
function parseResponse(buf: Buffer): number[] | null {
  let search = buf
  if (buf.subarray(0, ACK_FRAME.length).equals(ACK_FRAME)) {
    search = buf.subarray(ACK_FRAME.length)
  }
  const idx = search.indexOf(Buffer.from([START1, START2]))
  if (idx === -1 || idx + 4 > search.length) return null
  const len = search[idx + 2]
  const start = idx + 4
  if (start + len > search.length) return null
  return Array.from(search.subarray(start, start + len))
}

type Pn532Events = {
  /** A tag was seen and, within that same open cycle, either read (text is its NDEF
   *  text payload, or null if it has none/isn't in this app's format) or written to (if
   *  a write was pending - see requestWrite()). */
  tag: [tag: NfcTag & { text: string | null }]
  /** A write requested via requestWrite() finished, successfully or not, during this
   *  cycle - the definitive outcome, since the write happens deep inside the poll loop
   *  where a plain return value can't get back to the original caller. uid is the tag
   *  actually written to, so a persisted uid -> gameId record can be kept in sync. */
  writeResult: [ok: boolean, uid: string, error?: Error]
  /** Fired the first cycle a previously-present tag is no longer detected - lets a
   *  caller know when it's safe to allow a new write again, since a tag lifted off and
   *  put back would otherwise look identical to "still sitting there" from a single
   *  poll's perspective. */
  tagRemoved: [uid: string]
  error: [err: Error]
  /** Fired whenever a poll cycle's handshake starts/succeeds/fails - purely
   *  informational, useful for surfacing "reader reconnecting..." in the UI. */
  status: [status: 'connecting' | 'connected' | 'disconnected']
  /** Fired on every handshake attempt within a cycle, success or not - the only way to
   *  see (e.g. via a console.log in the caller) that it's actively retrying rather than
   *  silently stuck. */
  handshake: [attempt: number, ok: boolean]
}

/**
 * Runs a poll loop for tags while `startPolling()` is active, holding one connection
 * open across polls (see the class doc comment above) rather than reconnecting every
 * tick. Reconnects only when a run of consecutive failed polls indicates the connection
 * itself has actually gone bad.
 */
/** How many consecutive failed polls (no response at all, not just "no tag present")
 *  before the connection is treated as actually dead and gets torn down/reopened. */
const MAX_CONSECUTIVE_FAILURES = 5

export class Pn532 extends EventEmitter<Pn532Events> {
  private devicePath: string
  private port: SerialPort | null = null
  private polling = false
  private closed = false
  private lastUid: string | null = null
  private consecutiveFailures = 0
  /** Last error *code* (e.g. 'EACCES') surfaced via the 'error' event, so a permissions
   *  problem gets reported once instead of on every ~150ms poll retry - see handshake(). */
  private lastErrorCode: string | null = null
  /** Set via requestWrite(); consumed by the next tag seen, then cleared - same
   *  "next tag wins" contract the old design had. */
  private pendingWriteText: string | null = null

  constructor(devicePath: string) {
    super()
    this.devicePath = devicePath
  }

  /** Makes the next tag detected get written to instead of read from. Only one write
   *  can be pending at a time - callers should check that themselves (nfcManager does). */
  requestWrite(text: string): void {
    this.pendingWriteText = text
  }

  cancelPendingWrite(): void {
    this.pendingWriteText = null
  }

  private async openPort(): Promise<void> {
    this.port = new SerialPort({ path: this.devicePath, baudRate: 115200 })
    await new Promise<void>((resolve, reject) => {
      this.port!.once('open', () => resolve())
      this.port!.once('error', reject)
    })
  }

  /** Closes the serial port, optionally sending the chip a proper goodbye first -
   *  matching nfcpy's Device.close(): cancel any in-flight command with a bare ACK
   *  frame, wait 10ms, then fire PowerDown with HSU (the UART itself) listed as a
   *  wakeup source, so the next open's traffic wakes it straight back up. Only
   *  attempted when the connection was actually up - there's nothing to cancel or sleep
   *  if the chip never answered in the first place. Not awaiting PowerDown's response -
   *  it's never read anyway and the port closes regardless of what comes back. */
  private async closePort(graceful: boolean): Promise<void> {
    if (graceful && this.port?.isOpen) {
      try {
        await this.write(ACK_FRAME)
        await this.sleep(10)
        await this.write(frame([HOST_TO_PN532, CMD_POWERDOWN, POWERDOWN_WAKEUP_HSU, 0x00]))
      } catch {
        // best-effort - if this doesn't land the chip may come up a little rougher on
        // the next open, but the port still gets closed either way below
      }
    }
    try {
      this.port?.removeAllListeners()
      if (this.port?.isOpen) this.port.close()
    } catch {
      // already gone - fine
    }
    this.port = null
  }

  /** Opens the serial port fresh and repeats the wakeup/SAMConfiguration handshake
   *  until it succeeds or maxAttempts is hit - this board doesn't reliably respond on
   *  the first try even when otherwise healthy. Always opens a brand new port rather
   *  than reusing one: if the physical device was unplugged and replugged, a held-open
   *  descriptor is stale even though /dev/ttyUSBx re-appears at the same path, and only
   *  actually opening fresh binds to the new device instance. Returns whether the
   *  handshake succeeded; the port is left open on success, closed on failure. Only
   *  called at startPolling() time and after a reconnect - NOT on every poll tick, that
   *  was the previous, much slower design (see the class doc comment). */
  private async handshake(maxAttempts: number): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts && !this.closed; attempt++) {
      try {
        await this.openPort()
        // 10-byte all-zero preamble, exactly matching nfcpy's init() - not a guess.
        await this.write(Buffer.alloc(10))
        const resp = await this.sendCommand([CMD_SAMCONFIGURATION, 0x01, 0x14, 0x01], 1500)
        this.emit('handshake', attempt, !!resp)
        if (resp) {
          // Critical: the PN532's factory-default MxRtyPassiveActivation retry count is
          // 0xFF (infinite) - without setting it explicitly, InListPassiveTarget with no
          // tag present never returns a response frame at all, it just blocks inside the
          // chip's firmware indefinitely. Confirmed directly: a raw byte-level test sent
          // InListPassiveTarget and got only the ACK frame back, then genuinely nothing
          // else for 3+ seconds with no tag present. This is nfcpy's own
          // rf_configuration(0x05, b"\x01\x00\x01") - MxRtyATR/MxRtyPSL/
          // MxRtyPassiveActivation = 1/0/1 - matched exactly, not guessed at.
          await this.sendCommand(
            [CMD_RFCONFIGURATION, 0x05, 0x01, 0x00, 0x01],
            300
          )
          this.consecutiveFailures = 0
          this.lastErrorCode = null
          return true
        }
      } catch (err) {
        // EACCES (the device node exists but this user can't open it - the classic gap
        // between distros/images that pre-add the user to `dialout`/give it a udev ACL
        // and ones that don't) will never resolve itself by retrying the handshake, and
        // previously looked byte-for-byte identical to "chip just isn't answering yet":
        // a silent, endlessly-retried 'no response'. Surface it once (not on every
        // ~150ms poll tick - see pollLoop) instead of leaving it indistinguishable from
        // a genuinely dead/unplugged reader.
        //
        // @serialport/bindings-cpp's own BindingsError (thrown by openPort() above)
        // never sets .code at all - confirmed directly in its source
        // (dist/errors.js only carries a message + .canceled, and the native addon
        // builds that message as "Error %s Cannot open %s" with %s = strerror(errno),
        // i.e. the literal text "Permission denied", not the symbolic errno name) - so
        // a `.code === 'EACCES'` check here can never match a real permission failure
        // from this library. Match on the message text it actually produces instead,
        // falling back to .code too in case some other error path does set it.
        const message = err instanceof Error ? err.message : String(err)
        const code = (err as NodeJS.ErrnoException)?.code
        const isPermissionError = code === 'EACCES' || /permission denied/i.test(message)
        if (isPermissionError && this.lastErrorCode !== 'EACCES') {
          this.lastErrorCode = 'EACCES'
          this.emit(
            'error',
            new Error(
              `Permission denied opening ${this.devicePath}. Add your user to the ` +
                `"dialout" group (sudo usermod -aG dialout $USER, then log out and back ` +
                `in) or add a udev rule granting access to the reader.`
            )
          )
        }
        this.emit('handshake', attempt, false)
      }
      await this.closePort(false)
      if (attempt < maxAttempts) await this.sleep(Math.min(500 * attempt, 5000))
    }
    return false
  }

  /** Flushes any unread input immediately before writing, exactly matching nfcpy's
   *  TTY.write (`tty.flushInput()` before every write). Without this, bytes left over
   *  in the OS receive buffer from a previous cut-short exchange silently desync every
   *  later parse - confirmed directly via a raw byte-level test against the hardware,
   *  where stale trailing bytes from an old response were still sitting in the buffer. */
  private async write(buf: Buffer): Promise<void> {
    if (!this.port) throw new Error('Port not open')
    await new Promise<void>((resolve, reject) => {
      this.port!.flush((err) => (err ? reject(err) : resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      this.port!.write(buf, (err) => (err ? reject(err) : resolve()))
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Resolves as soon as a complete response frame (ACK optionally followed by the real
   *  frame) has actually arrived, instead of always waiting the full timeout regardless
   *  of how fast the reply came back - confirmed directly that the previous
   *  always-wait-the-full-window version made a real ~6ms round trip look like it took
   *  1500ms+. Still falls back to waiting out the full timeout if nothing complete ever
   *  arrives (the "genuinely no response" case). */
  private readAvailable(timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve) => {
      let data = Buffer.alloc(0)
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        this.port?.off('data', onData)
        clearTimeout(timer)
        resolve(data)
      }
      const onData = (chunk: Buffer): void => {
        data = Buffer.concat([data, chunk])
        if (parseResponse(data) !== null) finish()
      }
      this.port?.on('data', onData)
      const timer = setTimeout(finish, timeoutMs)
    })
  }

  /** Sends one command frame, waits for the ack + response, and returns the response
   *  payload (with the command-response byte stripped off the front). */
  private async sendCommand(payload: number[], timeoutMs = 1000): Promise<number[] | null> {
    await this.write(frame([HOST_TO_PN532, ...payload]))
    const raw = await this.readAvailable(timeoutMs)
    const resp = parseResponse(raw)
    // Response starts with PN532_TO_HOST then the command byte + 1 - drop both, the
    // caller only wants the actual data that follows.
    if (!resp || resp.length < 2 || resp[0] !== PN532_TO_HOST) return null
    return resp.slice(2)
  }

  /** Polls for a passive target once over the currently-open port; returns its UID (hex
   *  string) if one is present, or null for "no tag right now" - a real, validly parsed
   *  reply from the chip that just says zero targets were found. Throws when nothing
   *  parseable came back at all, which is what the caller's consecutive-failure counter
   *  needs to distinguish from an ordinary "nothing on the reader" tick. */
  private async pollOnce(): Promise<string | null> {
    // 1 target, 106 kbps type A - covers every common consumer NFC tag.
    const resp = await this.sendCommand([CMD_INLISTPASSIVETARGET, 0x01, 0x00], 400)
    if (!resp) throw new Error('No response to InListPassiveTarget')
    if (resp.length < 1 || resp[0] === 0) return null // valid reply, zero targets found
    if (resp.length < 6) return null
    const uidLen = resp[5]
    const uidBytes = resp.slice(6, 6 + uidLen)
    if (uidBytes.length !== uidLen) return null
    return Buffer.from(uidBytes).toString('hex')
  }

  startPolling(intervalMs = 150): void {
    if (this.polling) return
    this.polling = true
    void this.pollLoop(intervalMs)
  }

  stopPolling(): void {
    this.polling = false
  }

  /** Connects once and polls repeatedly against that same open connection - not a
   *  reopen-every-tick design (see the class doc comment for why that was both slow and
   *  plausibly the cause of "keeps killing itself while scanning"). Only reconnects when
   *  handshake() itself fails, or when a run of MAX_CONSECUTIVE_FAILURES consecutive
   *  failed polls indicates the held-open connection has actually gone bad - a single
   *  failed poll is not enough on its own, since "no tag right now" and "one dropped
   *  byte on an otherwise fine link" both look like a failed poll from here. */
  private async pollLoop(intervalMs: number): Promise<void> {
    while (this.polling && !this.closed) {
      this.emit('status', 'connecting')
      const ok = await this.handshake(3)
      if (!ok) {
        this.emit('status', 'disconnected')
        this.clearLastUid()
        await this.sleep(intervalMs)
        continue
      }
      this.emit('status', 'connected')
      this.consecutiveFailures = 0

      while (this.polling && !this.closed && this.port?.isOpen) {
        let uid: string | null = null
        try {
          uid = await this.pollOnce()
          this.consecutiveFailures = 0
        } catch {
          this.consecutiveFailures++
        }

        if (uid) {
          if (uid !== this.lastUid) {
            this.lastUid = uid
            await this.handleTagPresent(uid)
          }
        } else {
          this.clearLastUid() // no tag present - lets a re-tap re-trigger
        }

        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break
        await this.sleep(intervalMs)
      }

      this.emit('status', 'disconnected')
      await this.closePort(true)
    }
  }

  private clearLastUid(): void {
    if (this.lastUid !== null) {
      this.emit('tagRemoved', this.lastUid)
      this.lastUid = null
    }
  }

  /** Reads or writes the tag that's present right now, within the current still-open
   *  cycle, then emits the result - a write consumes and clears the pending request,
   *  otherwise the tag's current contents are read. */
  private async handleTagPresent(uid: string): Promise<void> {
    if (this.pendingWriteText !== null) {
      const text = this.pendingWriteText
      this.pendingWriteText = null
      try {
        await this.writeText(text)
        this.emit('writeResult', true, uid)
      } catch (err) {
        this.emit('writeResult', false, uid, err instanceof Error ? err : new Error(String(err)))
      }
      return
    }
    const text = await this.readText().catch(() => null)
    this.emit('tag', { uid, text })
  }

  /** Reads the NDEF text payload written by writeText(), or null if the tag has none
   *  in the format this class writes (a single short text record, no other apps'
   *  encodings are parsed - this isn't a general NDEF library). Must be called with the
   *  port already open and a tag present. */
  private async readText(): Promise<string | null> {
    const pages: number[] = []
    for (let page = NDEF_START_PAGE; page < NDEF_START_PAGE + USABLE_PAGES; page += 4) {
      const resp = await this.sendCommand([CMD_INDATAEXCHANGE, 0x01, MF_READ, page], 500)
      if (!resp || resp[0] !== 0x00) break
      pages.push(...resp.slice(1, 1 + 16))
    }
    return decodeNdefText(Buffer.from(pages))
  }

  /** Must be called with the port already open and a tag present, same as readText(). */
  private async writeText(text: string): Promise<void> {
    const payload = encodeNdefText(text)
    if (payload.length > USABLE_PAGES * PAGE_SIZE) {
      throw new Error('Text is too long to fit on this tag.')
    }
    const padded = Buffer.concat([
      payload,
      Buffer.alloc(PAGE_SIZE - (payload.length % PAGE_SIZE || PAGE_SIZE))
    ])
    for (let i = 0; i * PAGE_SIZE < padded.length; i++) {
      const page = NDEF_START_PAGE + i
      const chunk = padded.subarray(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE)
      const resp = await this.sendCommand([CMD_INDATAEXCHANGE, 0x01, MF_WRITE, page, ...chunk], 800)
      if (!resp || resp[0] !== 0x00) {
        throw new Error(`Write failed at page ${page} (tag removed too early, or it's read-only).`)
      }
    }
  }

  close(): void {
    this.closed = true
    this.polling = false
    // Fire-and-forget: callers (app shutdown, reconnect) don't await close(), and the
    // graceful PowerDown sequence is a best-effort courtesy to the chip, not something
    // worth blocking teardown on.
    void this.closePort(true)
  }
}

/** Wraps text in a minimal single-record NDEF TLV (type 'T', well-known text record,
 *  English, UTF-8) - the same shape any standard NFC reader/phone can decode. */
function encodeNdefText(text: string): Buffer {
  const langCode = Buffer.from('en', 'ascii')
  const textBytes = Buffer.from(text, 'utf-8')
  const payload = Buffer.concat([Buffer.from([langCode.length]), langCode, textBytes])
  const record = Buffer.concat([
    Buffer.from([0xd1, 0x01, payload.length, 0x54]), // MB/ME/SR/TNF=1, type len 1, payload len, type 'T'
    payload
  ])
  const tlv = Buffer.concat([Buffer.from([0x03, record.length]), record, Buffer.from([0xfe])])
  return tlv
}

function decodeNdefText(buf: Buffer): string | null {
  if (buf.length < 2 || buf[0] !== 0x03) return null
  const tlvLen = buf[1]
  const record = buf.subarray(2, 2 + tlvLen)
  if (record.length < 4 || record[3] !== 0x54) return null
  const payloadLen = record[2]
  const payload = record.subarray(4, 4 + payloadLen)
  const langLen = payload[0]
  const text = payload.subarray(1 + langLen)
  try {
    return text.toString('utf-8')
  } catch {
    return null
  }
}
