export interface CreateActivityTrackerOpts {
  /** Idle timeout in milliseconds. Use `0` to disable idle detection. */
  timeoutMs: number
  /** Fired once when the tracker has been idle for `timeoutMs`. */
  onIdle: () => void
}

export interface ActivityTracker {
  /** Call this on every user input. Resets the idle timer. */
  recordActivity(): void
  /** Start watching for idle. */
  start(): void
  /** Stop the timer; recordActivity becomes a no-op. */
  stop(): void
  /** True if the tracker is started and not yet stopped. */
  isActive(): boolean
}

export function createActivityTracker(opts: CreateActivityTrackerOpts): ActivityTracker {
  const { timeoutMs, onIdle } = opts
  let active = false
  let idleTimer: NodeJS.Timeout | null = null

  function scheduleCheck(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (!active) return
      try {
        onIdle()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[activity-tracker] onIdle threw:', err)
      }
    }, timeoutMs)
  }

  function clear(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  return {
    recordActivity(): void {
      if (!active || timeoutMs <= 0) return
      scheduleCheck()
    },
    start(): void {
      if (active) return
      active = true
      if (timeoutMs > 0) scheduleCheck()
    },
    stop(): void {
      active = false
      clear()
    },
    isActive(): boolean {
      return active
    },
  }
}
