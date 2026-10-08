export type NavAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'confirm'
  | 'back'
  | 'options'
  | 'tabLeft'
  | 'tabRight'
  | 'start'

/**
 * Keyboard -> controller-style action, shared by the library, Big Picture and the modals.
 *
 * Covers the Steam Controller: Chromium can't read it as a gamepad, and outside a game Steam
 * drives it with its Desktop Layout, which sends keys - by default (controller_base/
 * desktop_steamcontroller_gordon.vdf): stick/left pad = arrows, A = Enter, B = Space,
 * Y = Page Down, LB = Ctrl, RB = Alt, Back = Escape, Menu = Tab. Mapping those keys to the
 * same actions as a gamepad's buttons makes it drive OmniLauncher like any controller.
 * Ctrl/Alt only count when pressed on their own, so real shortcuts are unaffected.
 */
export function keyNavAction(e: KeyboardEvent): NavAction | null {
  if (e.repeat && (e.key === 'Control' || e.key === 'Alt' || e.key === 'Tab')) return null
  switch (e.key) {
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    case 'Enter':
      return 'confirm'
    case 'Escape':
    case ' ':
      return 'back'
    case 'PageDown':
      return 'options'
    case 'Control':
      return 'tabLeft'
    case 'Alt':
      return 'tabRight'
    case 'Tab':
      return e.shiftKey || e.ctrlKey || e.altKey ? null : 'start'
    case 'F11':
      return 'start'
    default:
      return null
  }
}

/** True while the user is typing somewhere - keys belong to the text field then. */
export function typingInField(): boolean {
  const el = document.activeElement
  return (
    !!el &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)
  )
}
