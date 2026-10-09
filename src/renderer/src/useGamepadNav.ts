import { useEffect, useRef } from 'react'
import { typingInField } from './keyNav'

type Direction = 'up' | 'down' | 'left' | 'right'

interface Handlers {
  /** While false, all polling still runs (so button state stays in sync and nothing
   *  fires the instant it flips back to true) but no handler is ever called. */
  enabled: boolean
  onDirection: (dir: Direction) => void
  onConfirm: () => void
  onBack: () => void
  onTabLeft: () => void
  onTabRight: () => void
  /** Y / triangle - open the focused game's options (artwork, NFC). */
  onOptions?: () => void
  /** Start / menu - toggles Big Picture mode. */
  onStart?: () => void
}

const DEADZONE = 0.5

/**
 * Hold-to-scroll timing, shared by the D-pad, the stick and the arrow keys: one move the
 * instant a direction is pressed, a short pause (so a tap moves exactly once), then
 * repeats that come quicker the longer it's held - 140 ms, 115, 94... down to 40 ms after
 * about a second - instead of a fixed rate, or the OS key repeat's long stall followed by
 * a flat-out race. `repeats` is how many repeats have fired since the press.
 */
export function navRepeatDelay(repeats: number): number {
  if (repeats === 0) return 250
  return Math.max(40, 140 * Math.pow(0.82, repeats - 1))
}

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
/** Arrow keydowns the hold-to-scroll timer below sends itself. */
const syntheticKeys = new WeakSet<Event>()
let heldKey: { key: string; code: string; timer: number } | null = null

function stopKeyRepeat(): void {
  if (heldKey) clearTimeout(heldKey.timer)
  heldKey = null
}

function startKeyRepeat(e: KeyboardEvent): void {
  stopKeyRepeat()
  const held = { key: e.key, code: e.code, timer: 0 }
  heldKey = held
  let repeats = 0
  const fire = (): void => {
    if (heldKey !== held) return
    const ev = new KeyboardEvent('keydown', {
      key: held.key,
      code: held.code,
      bubbles: true,
      cancelable: true
    })
    syntheticKeys.add(ev)
    window.dispatchEvent(ev)
    held.timer = window.setTimeout(fire, navRepeatDelay(++repeats))
  }
  held.timer = window.setTimeout(fire, navRepeatDelay(0))
}

/** When the controller was last actually used (a button held, a stick or D-pad pushed). */
let lastGamepadActivity = -Infinity

/** While a game is running the launcher doesn't need the controller at all - polling it
 *  every display frame (240 times a second here) kept waking the renderer and GPU process
 *  for nothing while the game was trying to hold its frame rate. */
let pollingPaused = false
export function setGamepadPollingPaused(paused: boolean): void {
  pollingPaused = paused
}

/** ~60 polls a second is plenty for menu navigation, whatever the display refresh rate. */
const POLL_INTERVAL_MS = 16

/**
 * With Steam Input on, Steam applies its Desktop Layout to the controller whenever no Steam
 * game is focused - it injects mouse movement, clicks and key presses (A -> Enter, B ->
 * Escape...) for the same physical input this hook already handles. Without this guard one
 * press acted twice (e.g. Enter re-triggering the action A just did). While the controller
 * is in use, those injected keyboard/mouse events are dropped before any handler sees them;
 * real keyboard/mouse use is unaffected once the controller has been idle a moment.
 */
export function installDesktopLayoutGuard(): () => void {
  // Arrow keys (a keyboard, or the D-pad/stick through Steam's Desktop Layout) get the
  // same accelerating hold-to-scroll as the gamepad: the OS's own repeats are dropped and
  // replaced by navRepeatDelay()'s. Text fields keep the normal key repeat.
  const keyRepeat = (e: Event): void => {
    const k = e as KeyboardEvent
    if (e.type === 'keyup') {
      if (heldKey?.key === k.key) stopKeyRepeat()
      return
    }
    if (!ARROW_KEYS.has(k.key) || syntheticKeys.has(e) || typingInField()) return
    if (k.repeat) {
      e.stopImmediatePropagation()
      e.preventDefault()
      return
    }
    // A press the gamepad guard below drops (the pad already moved) mustn't start one.
    if (performance.now() - lastGamepadActivity > 300) startKeyRepeat(k)
  }
  window.addEventListener('keydown', keyRepeat, { capture: true })
  window.addEventListener('keyup', keyRepeat, { capture: true })
  window.addEventListener('blur', stopKeyRepeat)

  const types = [
    'keydown',
    'keyup',
    'mousedown',
    'mouseup',
    'click',
    'contextmenu',
    'wheel',
    'mousemove'
  ]
  const guard = (e: Event): void => {
    if (performance.now() - lastGamepadActivity > 300) return
    e.stopImmediatePropagation()
    if (e.type !== 'mousemove') e.preventDefault()
  }
  for (const t of types) window.addEventListener(t, guard, { capture: true, passive: false })
  return () => {
    for (const t of types) window.removeEventListener(t, guard, { capture: true })
    window.removeEventListener('keydown', keyRepeat, { capture: true })
    window.removeEventListener('keyup', keyRepeat, { capture: true })
    window.removeEventListener('blur', stopKeyRepeat)
    stopKeyRepeat()
  }
}

/**
 * Polls the Gamepad API (dpad + left stick + A/B buttons) so the grid can be
 * driven from a controller, in addition to the keyboard handler wired in App.tsx.
 */
export function useGamepadNav(handlers: Handlers): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    let raf = 0
    // Hold-to-scroll state for the D-pad/stick (see navRepeatDelay).
    let heldDir: Direction | null = null
    let nextMoveAt = 0
    let repeats = 0
    const prevButtons: boolean[] = []

    let lastPoll = 0
    function poll(): void {
      if (pollingPaused) {
        // Check back occasionally instead of every frame until the game has closed.
        raf = window.setTimeout(() => (raf = requestAnimationFrame(poll)), 500)
        return
      }
      const nowMs = performance.now()
      if (nowMs - lastPoll < POLL_INTERVAL_MS) {
        raf = requestAnimationFrame(poll)
        return
      }
      lastPoll = nowMs
      const pads = navigator.getGamepads ? navigator.getGamepads() : []
      const pad = pads[0]
      if (pad) {
        const enabled = handlersRef.current.enabled
        const now = performance.now()
        const axisX = pad.axes[0] ?? 0
        const axisY = pad.axes[1] ?? 0
        // Controllers Chromium has no mapping for (mapping !== 'standard' - e.g. the
        // 8BitDo Ultimate 2C) expose raw evdev order instead: buttons follow the kernel's
        // key codes (A, B, X, Y, LB, RB, Select, Start, Guide, L3, R3 - so Start is 7, not
        // 9, and 9 is actually the left stick click), and the D-pad is a hat on axes 6/7
        // rather than buttons 12-15. Without this, Start and the D-pad did nothing.
        const standard = pad.mapping === 'standard'
        // Activity = a button held or a stick/D-pad pushed. Only stick and hat axes count:
        // in raw (non-standard) order the triggers rest at -1, which would otherwise read
        // as permanent activity.
        const stickAxes = standard ? [0, 1, 2, 3] : [0, 1, 3, 4, 6, 7]
        if (
          pad.buttons.some((b) => b.pressed) ||
          stickAxes.some((i) => Math.abs(pad.axes[i] ?? 0) > 0.35)
        ) {
          lastGamepadActivity = performance.now()
        }
        const hatX = standard ? 0 : (pad.axes[6] ?? 0)
        const hatY = standard ? 0 : (pad.axes[7] ?? 0)
        const dpadUp = (standard && pad.buttons[12]?.pressed) || hatY < -DEADZONE
        const dpadDown = (standard && pad.buttons[13]?.pressed) || hatY > DEADZONE
        const dpadLeft = (standard && pad.buttons[14]?.pressed) || hatX < -DEADZONE
        const dpadRight = (standard && pad.buttons[15]?.pressed) || hatX > DEADZONE

        let dir: Direction | null = null
        if (dpadUp || axisY < -DEADZONE) dir = 'up'
        else if (dpadDown || axisY > DEADZONE) dir = 'down'
        else if (dpadLeft || axisX < -DEADZONE) dir = 'left'
        else if (dpadRight || axisX > DEADZONE) dir = 'right'
        if (!dir || !enabled) {
          heldDir = null
        } else if (dir !== heldDir) {
          heldDir = dir
          repeats = 0
          handlersRef.current.onDirection(dir)
          nextMoveAt = now + navRepeatDelay(0)
        } else if (now >= nextMoveAt) {
          handlersRef.current.onDirection(dir)
          nextMoveAt = now + navRepeatDelay(++repeats)
        }

        const aPressed = !!pad.buttons[0]?.pressed
        const bPressed = !!pad.buttons[1]?.pressed
        // Standard gamepad mapping: index 4 = left bumper (LB/L1), 5 = right bumper (RB/R1).
        const lbPressed = !!pad.buttons[4]?.pressed
        const rbPressed = !!pad.buttons[5]?.pressed
        if (enabled && aPressed && !prevButtons[0]) handlersRef.current.onConfirm()
        if (enabled && bPressed && !prevButtons[1]) handlersRef.current.onBack()
        if (enabled && lbPressed && !prevButtons[4]) handlersRef.current.onTabLeft()
        if (enabled && rbPressed && !prevButtons[5]) handlersRef.current.onTabRight()
        // Y/triangle is 3 in both layouts; Start is 9 (standard) or 7 (raw evdev order).
        const startIndex = standard ? 9 : 7
        const yPressed = !!pad.buttons[3]?.pressed
        const startPressed = !!pad.buttons[startIndex]?.pressed
        if (enabled && yPressed && !prevButtons[3]) handlersRef.current.onOptions?.()
        if (enabled && startPressed && !prevButtons[startIndex]) handlersRef.current.onStart?.()
        prevButtons[0] = aPressed
        prevButtons[1] = bPressed
        prevButtons[3] = yPressed
        prevButtons[4] = lbPressed
        prevButtons[5] = rbPressed
        prevButtons[startIndex] = startPressed
      }
      raf = requestAnimationFrame(poll)
    }

    raf = requestAnimationFrame(poll)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(raf)
    }
  }, [])
}
