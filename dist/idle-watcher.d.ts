import type { SessionService } from './session-service';
export declare const DEFAULT_IDLE_POLL_MS = 5000;
export declare const DEFAULT_SLEEP_DETECTION_MULTIPLIER = 3;
export interface CreateIdleWatcherOpts {
    sessionService: SessionService;
    /** Fired when the session is detected as expired or externally locked. */
    onLock: () => void;
    /** Poll interval in ms (default 5000). */
    pollMs?: number;
    /**
     * Multiplier applied to `pollMs`. When two consecutive ticks are more than
     * `pollMs * sleepDetectionMultiplier` apart, the watcher assumes the system
     * was asleep and grants the user a fresh idle window (by calling
     * `sessionService.recordActivity()`) instead of locking immediately.
     *
     * Default: 3 — i.e. with `pollMs=5000`, sleep is detected when a tick comes
     * more than 15s after the previous one.
     *
     * Set to `Infinity` to disable sleep detection (legacy v1.1.x behavior:
     * lock immediately on resume from sleep).
     */
    sleepDetectionMultiplier?: number;
}
export interface IdleWatcher {
    start(): void;
    stop(): void;
    isRunning(): boolean;
}
/**
 * Main-process watcher that triggers `onLock` when the shared session expires
 * or is locked by another app. Combines polling (for time-based expiration)
 * with session.watch() (for instant cross-app lock notification).
 *
 * `onLock` is called at most once per start() cycle. Call start() again after
 * a fresh unlock.
 *
 * Sleep-aware: when the gap between two consecutive checks exceeds
 * `pollMs * sleepDetectionMultiplier`, the watcher assumes the system slept
 * and bumps `lastActivityAt` to grant a fresh idle window — preventing the
 * "lock fires immediately on resume" footgun.
 */
export declare function createIdleWatcher(opts: CreateIdleWatcherOpts): IdleWatcher;
//# sourceMappingURL=idle-watcher.d.ts.map