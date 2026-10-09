/**
 * Scroll behavior for keeping the focused item in view. A single step animates smoothly,
 * but while a direction is held moves arrive every 40-250 ms - each new smooth scroll
 * restarted the previous one before it got anywhere, so the view sat still the whole
 * time and only caught up (flying across the list) once the direction was released.
 * Steps that follow closely on the last one jump instantly instead, so the view keeps
 * pace with focus.
 */
let lastFollowAt = -Infinity

export function followScrollBehavior(): ScrollBehavior {
  const now = performance.now()
  const held = now - lastFollowAt < 300
  lastFollowAt = now
  return held ? 'instant' : 'smooth'
}
