"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.useIdleLock = useIdleLock;
const react_1 = require("react");
const activity_listener_1 = require("./activity-listener");
/**
 * Auto-lock the app after `timeoutMinutes` of inactivity in the renderer.
 *
 * Activity is detected via DOM events on `window` (mouse / keyboard / touch /
 * wheel). Callers can pass inline arrow functions for `onLock` and
 * `onActivity` without worrying about effect re-runs — the hook captures
 * the latest references via refs internally.
 */
function useIdleLock(opts) {
    const { timeoutMinutes, onLock, onActivity } = opts;
    const onLockRef = (0, react_1.useRef)(onLock);
    const onActivityRef = (0, react_1.useRef)(onActivity);
    (0, react_1.useEffect)(() => {
        onLockRef.current = onLock;
        onActivityRef.current = onActivity;
    }, [onLock, onActivity]);
    (0, react_1.useEffect)(() => {
        if (!timeoutMinutes || timeoutMinutes <= 0)
            return;
        return (0, activity_listener_1.attachActivityTracking)({
            target: window,
            timeoutMs: timeoutMinutes * 60_000,
            onIdle: () => onLockRef.current(),
            onActivity: () => onActivityRef.current?.(),
        });
    }, [timeoutMinutes]);
}
//# sourceMappingURL=react.js.map