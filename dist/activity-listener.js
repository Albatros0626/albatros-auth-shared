"use strict";
/**
 * Browser-side helper that bundles `createActivityTracker` with DOM event
 * listeners and a throttle for the per-event activity callback.
 *
 * Decoupled from React: returns a `dispose` function. A React-friendly hook
 * wrapper lives in `./react.ts` (subpath `@albatros/auth-shared/react`).
 *
 * Decoupled from DOM types: uses a structural `ActivityEventTarget` so this
 * file compiles in a Node tsconfig (no DOM lib). Browsers' `window` satisfies
 * the interface naturally.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_IPC_THROTTLE_MS = exports.DEFAULT_ACTIVITY_EVENTS = void 0;
exports.attachActivityTracking = attachActivityTracking;
const activity_tracker_1 = require("./activity-tracker");
/** Default DOM events watched. Same set used by all 3 consumer apps. */
exports.DEFAULT_ACTIVITY_EVENTS = [
    'mousemove',
    'mousedown',
    'keydown',
    'touchstart',
    'wheel',
];
exports.DEFAULT_IPC_THROTTLE_MS = 1_000;
/**
 * Wires up an `ActivityTracker` to DOM events on `target`.
 *
 * - Every tracked DOM event resets the idle timer (no throttle on tracker).
 * - `onActivity` (typically the IPC bump) is throttled to `throttleMs` so
 *   the main process is not flooded with mousemoves.
 * - Returns a dispose function that stops the tracker and detaches listeners.
 *
 * Calling `attachActivityTracking({ timeoutMs: 0, ... })` returns a no-op
 * dispose without attaching anything.
 */
function attachActivityTracking(opts) {
    const { target, timeoutMs, onIdle, onActivity, events = exports.DEFAULT_ACTIVITY_EVENTS, throttleMs = exports.DEFAULT_IPC_THROTTLE_MS, } = opts;
    if (!timeoutMs || timeoutMs <= 0) {
        return () => { };
    }
    const tracker = (0, activity_tracker_1.createActivityTracker)({ timeoutMs, onIdle });
    tracker.start();
    // Use -Infinity so the very first event always fires (leading-edge throttle)
    // even when Date.now() returns 0 in tests with `vi.setSystemTime(0)`.
    let lastIpcCall = Number.NEGATIVE_INFINITY;
    const handler = () => {
        tracker.recordActivity();
        if (!onActivity)
            return;
        const now = Date.now();
        if (now - lastIpcCall > throttleMs) {
            lastIpcCall = now;
            onActivity();
        }
    };
    for (const evt of events) {
        target.addEventListener(evt, handler, { passive: true });
    }
    return () => {
        tracker.stop();
        for (const evt of events) {
            target.removeEventListener(evt, handler);
        }
    };
}
//# sourceMappingURL=activity-listener.js.map