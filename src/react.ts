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

import { useCallback, useEffect, useRef, useState } from 'react'
import { attachActivityTracking } from './activity-listener'
import type { BiometricUnlockResult } from './types'

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

export interface UseBiometricUnlockOpts {
  /**
   * Calls the main process, typically
   * `window.electronAPI.auth.biometricUnlock()`. Takes no argument: the window
   * handle Windows Hello needs is resolved in the main process from the IPC
   * sender, never in the renderer.
   */
  unlock: () => Promise<BiometricUnlockResult>
  /** Called once the vault actually unlocked. */
  onUnlocked?: () => void
}

export interface UseBiometricUnlockState {
  /** True while the Hello prompt is up. Measured 0.3s–5.6s in practice. */
  pending: boolean
  /** Fires the prompt. A second call while pending is ignored. */
  trigger: () => void
  /** Result of the last failed attempt; cleared when a new one starts. */
  failure: BiometricUnlockResult | null
}

/**
 * Drives a "Windows Hello" button next to the code field on a lock screen.
 *
 * Deliberately manual: never call `trigger` on mount. A prompt raised as the
 * screen appears often has no foreground yet, which is exactly the condition
 * that makes Windows return `WINBIO_E_INVALID_TICKET`; a click guarantees the
 * focus.
 *
 * The code field must stay usable while `pending` — the first path to succeed
 * wins. Blocking it would trap the user if Hello never answers, so this hook
 * discards a late biometric result instead: only the most recent `trigger`
 * can settle the state, and results arriving after unmount are dropped.
 *
 * ```tsx
 * const { pending, trigger, failure } = useBiometricUnlock({
 *   unlock: () => window.electronAPI.auth.biometricUnlock(),
 *   onUnlocked: () => navigate('/'),
 * })
 * ```
 */
export function useBiometricUnlock(opts: UseBiometricUnlockOpts): UseBiometricUnlockState {
  const { unlock, onUnlocked } = opts

  const unlockRef = useRef(unlock)
  const onUnlockedRef = useRef(onUnlocked)
  useEffect(() => {
    unlockRef.current = unlock
    onUnlockedRef.current = onUnlocked
  }, [unlock, onUnlocked])

  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<BiometricUnlockResult | null>(null)

  // Generation token: only the newest attempt may settle state. Guards both
  // the double-click race and a result landing after unmount.
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [])

  const pendingRef = useRef(false)

  const trigger = useCallback(() => {
    if (pendingRef.current) return
    pendingRef.current = true
    generationRef.current += 1
    const generation = generationRef.current

    setPending(true)
    setFailure(null)

    void (async () => {
      let result: BiometricUnlockResult
      try {
        result = await unlockRef.current()
      } catch (err) {
        // An IPC-level failure is not a biometric verdict; surface it as a
        // refusal rather than letting it escape an event handler unhandled.
        // eslint-disable-next-line no-console
        console.error('[biometric] unlock call failed:', err)
        result = { ok: false, failure: 'rejected', reason: 'unknown' }
      }

      pendingRef.current = false
      if (!mountedRef.current || generation !== generationRef.current) return

      setPending(false)
      if (result.ok) {
        onUnlockedRef.current?.()
      } else {
        setFailure(result)
      }
    })()
  }, [])

  return { pending, trigger, failure }
}
