"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SLEEP_DETECTION_MULTIPLIER = exports.DEFAULT_IDLE_POLL_MS = void 0;
exports.createIdleWatcher = createIdleWatcher;
exports.DEFAULT_IDLE_POLL_MS = 5_000;
exports.DEFAULT_SLEEP_DETECTION_MULTIPLIER = 3;
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
function createIdleWatcher(opts) {
    const { sessionService, onLock, pollMs = exports.DEFAULT_IDLE_POLL_MS, sleepDetectionMultiplier = exports.DEFAULT_SLEEP_DETECTION_MULTIPLIER, } = opts;
    let running = false;
    let interval = null;
    let unsubscribe = null;
    let triggered = false;
    let lastTickAt = 0;
    function check() {
        if (!running || triggered)
            return;
        const now = Date.now();
        const drift = lastTickAt === 0 ? 0 : now - lastTickAt;
        lastTickAt = now;
        // System-sleep detection: if the gap between ticks is much larger than
        // expected, the host was probably suspended. Bump activity instead of
        // locking — gives the user a fresh idle window after wake.
        if (drift > pollMs * sleepDetectionMultiplier) {
            try {
                sessionService.recordActivity();
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.error('[idle-watcher] recordActivity threw on wake:', err);
            }
            return;
        }
        const state = sessionService.read();
        if (!state)
            return;
        if (state.isLocked || state.isExpired) {
            triggered = true;
            try {
                onLock();
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.error('[idle-watcher] onLock threw:', err);
            }
            stopInternal();
        }
    }
    function stopInternal() {
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
        if (unsubscribe) {
            try {
                unsubscribe();
            }
            catch { /* ignore */ }
            unsubscribe = null;
        }
        running = false;
    }
    return {
        start() {
            if (running)
                return;
            running = true;
            triggered = false;
            lastTickAt = Date.now();
            // Set up the polling + watch FIRST so they're armed even if the deferred
            // initial check below fires onLock and stops us.
            interval = setInterval(check, pollMs);
            unsubscribe = sessionService.watch(() => check());
            // Defer the initial check to the next macrotask. If start() was called
            // from an unlock handler that does setUnlocked(true) → recordUnlock(...)
            // synchronously, the deferred check runs AFTER recordUnlock has updated
            // session.bin, avoiding the race where an immediate check would see
            // stale "locked" state and re-lock the app. (v2.0.1: defense-in-depth
            // for consumers that haven't reordered their unlock handlers yet.)
            setTimeout(() => { if (running)
                check(); }, 0);
        },
        stop() {
            stopInternal();
            lastTickAt = 0;
        },
        isRunning() {
            return running;
        },
    };
}
//# sourceMappingURL=idle-watcher.js.map