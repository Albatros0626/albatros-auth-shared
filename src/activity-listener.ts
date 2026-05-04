/**
 * Browser-side helper that bundles `createActivityTracker` with DOM event
 * listeners and a throttle for the per-event activity callback.
 *
 * Decoupled from React: returns a `dispose` function. A React-friendly hook
 * wrapper lives in `./react.ts` (subpath `@albatros/auth-shared/react`).
 *
 * Decoupled from DOM types: uses a structural `ActivityEventTarget` so this
 * file compiles in a Node tsconfig (no DOM lib). Browsers' `window` satisfies
 * the interface naturally.
 */

import { createActivityTracker } from './activity-tracker'

/** Default DOM events watched. Same set used by all 3 consumer apps. */
export const DEFAULT_ACTIVITY_EVENTS: ReadonlyArray<string> = [
  'mousemove',
  'mousedown',
  'keydown',
  'touchstart',
  'wheel',
]

export const DEFAULT_IPC_THROTTLE_MS = 1_000

/**
 * Structural type for an event target — `Window` and any test stub fit.
 * Avoids forcing the package's tsconfig to include the DOM lib.
 */
export interface ActivityEventTarget {
  addEventListener(
    event: string,
    listener: () => void,
    options?: { passive?: boolean }
  ): void
  removeEventListener(event: string, listener: () => void): void
}

export interface AttachActivityTrackingOpts {
  /** Where to attach the DOM listeners. Pass `window` from the renderer. */
  target: ActivityEventTarget
  /** Idle timeout in milliseconds. */
  timeoutMs: number
  /** Fired after `timeoutMs` without any tracked event. */
  onIdle: () => void
  /** Fired on each tracked event, throttled to `throttleMs`. Optional. */
  onActivity?: () => void
  /** Events to listen for. Default: mouse + keyboard + wheel + touch. */
  events?: ReadonlyArray<string>
  /** Throttle for `onActivity` (default 1000ms). The internal idle tracker is unaffected. */
  throttleMs?: number
}

/**
 * Wires up an `ActivityTracker` to DOM events on `target`.
 *
 * - Every tracked DOM event resets the idle timer (no throttle on tracker).
 * - `onActivity` (typically the IPC bump) is throttled to `throttleMs` so
 *   the main process is not flooded with mousemoves.
 * - Returns a dispose function that stops the tracker and detaches listeners.
 *
 * Calling `attachActivityTracking({ timeoutMs: 0, ... })` returns a no-op
 * dispose without attaching anything.
 */
export function attachActivityTracking(opts: AttachActivityTrackingOpts): () => void {
  const {
    target,
    timeoutMs,
    onIdle,
    onActivity,
    events = DEFAULT_ACTIVITY_EVENTS,
    throttleMs = DEFAULT_IPC_THROTTLE_MS,
  } = opts

  if (!timeoutMs || timeoutMs <= 0) {
    return () => { /* no-op */ }
  }

  const tracker = createActivityTracker({ timeoutMs, onIdle })
  tracker.start()

  // Use -Infinity so the very first event always fires (leading-edge throttle)
  // even when Date.now() returns 0 in tests with `vi.setSystemTime(0)`.
  let lastIpcCall = Number.NEGATIVE_INFINITY
  const handler = (): void => {
    tracker.recordActivity()
    if (!onActivity) return
    const now = Date.now()
    if (now - lastIpcCall > throttleMs) {
      lastIpcCall = now
      onActivity()
    }
  }

  for (const evt of events) {
    target.addEventListener(evt, handler, { passive: true })
  }

  return () => {
    tracker.stop()
    for (const evt of events) {
      target.removeEventListener(evt, handler)
    }
  }
}
