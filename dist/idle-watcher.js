"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_IDLE_POLL_MS = void 0;
exports.createIdleWatcher = createIdleWatcher;
exports.DEFAULT_IDLE_POLL_MS = 5_000;
/**
 * Main-process watcher that triggers `onLock` when the shared session expires
 * or is locked by another app. Combines polling (for time-based expiration)
 * with session.watch() (for instant cross-app lock notification).
 *
 * `onLock` is called at most once per start() cycle. Call start() again after
 * a fresh unlock.
 */
function createIdleWatcher(opts) {
    const { sessionService, onLock, pollMs = exports.DEFAULT_IDLE_POLL_MS } = opts;
    let running = false;
    let interval = null;
    let unsubscribe = null;
    let triggered = false;
    function check() {
        if (!running || triggered)
            return;
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
            // Immediate check covers the case where session was already expired/locked at start
            check();
            if (!running)
                return; // start triggered onLock synchronously, already stopped
            interval = setInterval(check, pollMs);
            unsubscribe = sessionService.watch(() => check());
        },
        stop() {
            stopInternal();
        },
        isRunning() {
            return running;
        },
    };
}
//# sourceMappingURL=idle-watcher.js.map