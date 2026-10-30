/**
 * Low-level idle timer, deliberately absent from the `/browser` entry since
 * v4.0.0. To lock an app on inactivity, use `useIdleLock` (`/react`) or
 * `attachActivityTracking` (`/browser`): their `requestLock` goes through
 * `createRequestLockHandler`. Wiring `onIdle` straight to an unconditional lock
 * makes one idle app lock all the others (TROUBLESHOOTING Bug #4 and #5).
 */
export interface CreateActivityTrackerOpts {
    /** Idle timeout in milliseconds. Use `0` to disable idle detection. */
    timeoutMs: number;
    /** Fired once when the tracker has been idle for `timeoutMs`. */
    onIdle: () => void;
}
export interface ActivityTracker {
    /** Call this on every user input. Resets the idle timer. */
    recordActivity(): void;
    /** Start watching for idle. */
    start(): void;
    /** Stop the timer; recordActivity becomes a no-op. */
    stop(): void;
    /** True if the tracker is started and not yet stopped. */
    isActive(): boolean;
}
export declare function createActivityTracker(opts: CreateActivityTrackerOpts): ActivityTracker;
//# sourceMappingURL=activity-tracker.d.ts.map