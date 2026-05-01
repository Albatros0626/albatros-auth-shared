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