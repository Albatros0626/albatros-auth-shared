/**
 * React subpath of `@albatros/auth-shared`.
 *
 * Exposes a thin React hook around `attachActivityTracking` that handles the
 * usual footgun of passing inline arrow callbacks (which would re-create the
 * effect on every render and reset the idle timer). Internally uses refs so
 * the effect only re-runs when `timeoutMinutes` changes.
 *
 * Import as: `import { useIdleLock } from '@albatros/auth-shared/react'`
 *
 * React is declared as an optional peer dependency — only consumers of this
 * subpath need it installed.
 */

import { useEffect, useRef } from 'react'
import { attachActivityTracking } from './activity-listener'

export interface UseIdleLockOpts {
  /**
   * Idle timeout in minutes. Pass `0` (or negative) to disable the hook —
   * useful while the app is locked or before initial unlock.
   */
  timeoutMinutes: number
  /** Called once when the idle timeout elapses without activity. */
  onLock: () => void
  /**
   * Called on every tracked activity (throttled). Typically used to push the
   * activity to the main process via IPC so the cross-app session stays alive.
   */
  onActivity?: () => void
}

/**
 * Auto-lock the app after `timeoutMinutes` of inactivity in the renderer.
 *
 * Activity is detected via DOM events on `window` (mouse / keyboard / touch /
 * wheel). Callers can pass inline arrow functions for `onLock` and
 * `onActivity` without worrying about effect re-runs — the hook captures
 * the latest references via refs internally.
 */
export function useIdleLock(opts: UseIdleLockOpts): void {
  const { timeoutMinutes, onLock, onActivity } = opts

  const onLockRef = useRef(onLock)
  const onActivityRef = useRef(onActivity)
  useEffect(() => {
    onLockRef.current = onLock
    onActivityRef.current = onActivity
  }, [onLock, onActivity])

  useEffect(() => {
    if (!timeoutMinutes || timeoutMinutes <= 0) return
    return attachActivityTracking({
      target: window,
      timeoutMs: timeoutMinutes * 60_000,
      onIdle: () => onLockRef.current(),
      onActivity: () => onActivityRef.current?.(),
    })
  }, [timeoutMinutes])
}
