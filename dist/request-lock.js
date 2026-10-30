"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRequestLockHandler = createRequestLockHandler;
/**
 * Main-side half of the inactivity lock, the other half being the renderer's
 * `useIdleLock` / `attachActivityTracking`.
 *
 * The renderer's idle timer only sees the DOM events of ITS window. Were it
 * allowed to lock unconditionally, an Albatros app left open in the background
 * would lock every sibling once the timeout elapsed, while the user works in
 * another one — TROUBLESHOOTING Bug #4, then again Bug #5. So the request is
 * granted only when the shared session has expired, i.e. no Albatros app has
 * recorded activity within `lockTimeoutMinutes`.
 *
 * Register the returned function on the channel the renderer's `requestLock`
 * calls (convention: `auth:requestLock`). It ignores its arguments, so it can
 * be passed to `ipcMain.handle` as is. The manual lock button keeps its own
 * unconditional `auth:lock`: there, the user asked for it.
 */
function createRequestLockHandler(opts) {
    const { sessionService, authState } = opts;
    return () => {
        const state = sessionService.read();
        if (!state)
            return { locked: false, reason: 'no-session' };
        if (state.isLocked)
            return { locked: true, reason: 'already-locked' };
        if (!state.isExpired)
            return { locked: false, reason: 'cross-app-active' };
        sessionService.recordLock();
        authState.setUnlocked(false);
        return { locked: true, reason: 'expired' };
    };
}
//# sourceMappingURL=request-lock.js.map