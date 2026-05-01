import type { SessionService } from './session-service';
export declare const DEFAULT_IDLE_POLL_MS = 5000;
export interface CreateIdleWatcherOpts {
    sessionService: SessionService;
    /** Fired when the session is detected as expired or externally locked. */
    onLock: () => void;
    /** Poll interval in ms (default 5000). */
    pollMs?: number;
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
 */
export declare function createIdleWatcher(opts: CreateIdleWatcherOpts): IdleWatcher;
//# sourceMappingURL=idle-watcher.d.ts.map