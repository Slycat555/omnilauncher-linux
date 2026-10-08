import { useEffect, useRef } from 'react'

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
const REPEAT_MS = 220

/** When the controller was last actually used (a button held, a stick or D-pad pushed). */
let lastGamepadActivity = -Infinity

/**
 * With Steam Input on, Steam applies its Desktop Layout to the controller whenever no Steam
 * game is focused - it injects mouse movement, clicks and key presses (A -> Enter, B ->
 * Escape...) for the same physical input this hook already handles. Without this guard one
 * press acted twice (e.g. Enter re-triggering the action A just did). While the controller
 * is in use, those injected keyboard/mouse events are dropped before any handler sees them;
 * real keyboard/mouse use is unaffected once the controller has been idle a moment.
 */
export function installDesktopLayoutGuard(): () => void {
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
    let lastMove = 0
    const prevButtons: boolean[] = []

    function poll(): void {
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

        if (enabled && now - lastMove > REPEAT_MS) {
          let dir: Direction | null = null
          if (dpadUp || axisY < -DEADZONE) dir = 'up'
          else if (dpadDown || axisY > DEADZONE) dir = 'down'
          else if (dpadLeft || axisX < -DEADZONE) dir = 'left'
          else if (dpadRight || axisX > DEADZONE) dir = 'right'
          if (dir) {
            handlersRef.current.onDirection(dir)
            lastMove = now
          }
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
    return () => cancelAnimationFrame(raf)
  }, [])
}
