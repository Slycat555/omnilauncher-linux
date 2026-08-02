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
}

const DEADZONE = 0.5
const REPEAT_MS = 220

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
        const dpadUp = pad.buttons[12]?.pressed
        const dpadDown = pad.buttons[13]?.pressed
        const dpadLeft = pad.buttons[14]?.pressed
        const dpadRight = pad.buttons[15]?.pressed

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
        prevButtons[0] = aPressed
        prevButtons[1] = bPressed
        prevButtons[4] = lbPressed
        prevButtons[5] = rbPressed
      }
      raf = requestAnimationFrame(poll)
    }

    raf = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(raf)
  }, [])
}
