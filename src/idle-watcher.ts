import type { SessionService } from './session-service'

export const DEFAULT_IDLE_POLL_MS = 5_000

export interface CreateIdleWatcherOpts {
  sessionService: SessionService
  /** Fired when the session is detected as expired or externally locked. */
  onLock: () => void
  /** Poll interval in ms (default 5000). */
  pollMs?: number
}

export interface IdleWatcher {
  start(): void
  stop(): void
  isRunning(): boolean
}

/**
 * Main-process watcher that triggers `onLock` when the shared session expires
 * or is locked by another app. Combines polling (for time-based expiration)
 * with session.watch() (for instant cross-app lock notification).
 *
 * `onLock` is called at most once per start() cycle. Call start() again after
 * a fresh unlock.
 */
export function createIdleWatcher(opts: CreateIdleWatcherOpts): IdleWatcher {
  const { sessionService, onLock, pollMs = DEFAULT_IDLE_POLL_MS } = opts

  let running = false
  let interval: NodeJS.Timeout | null = null
  let unsubscribe: (() => void) | null = null
  let triggered = false

  function check(): void {
    if (!running || triggered) return
    const state = sessionService.read()
    if (!state) return
    if (state.isLocked || state.isExpired) {
      triggered = true
      try {
        onLock()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[idle-watcher] onLock threw:', err)
      }
      stopInternal()
    }
  }

  function stopInternal(): void {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
    if (unsubscribe) {
      try { unsubscribe() } catch { /* ignore */ }
      unsubscribe = null
    }
    running = false
  }

  return {
    start(): void {
      if (running) return
      running = true
      triggered = false
      // Immediate check covers the case where session was already expired/locked at start
      check()
      if (!running) return // start triggered onLock synchronously, already stopped
      interval = setInterval(check, pollMs)
      unsubscribe = sessionService.watch(() => check())
    },
    stop(): void {
      stopInternal()
    },
    isRunning(): boolean {
      return running
    },
  }
}
