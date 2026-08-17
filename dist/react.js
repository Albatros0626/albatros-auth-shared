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
exports.useBiometricUnlock = useBiometricUnlock;
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
/**
 * Drives a "Windows Hello" button next to the code field on a lock screen.
 *
 * Deliberately manual: never call `trigger` on mount. A prompt raised as the
 * screen appears often has no foreground yet, which is exactly the condition
 * that makes Windows return `WINBIO_E_INVALID_TICKET`; a click guarantees the
 * focus.
 *
 * The code field must stay usable while `pending` — the first path to succeed
 * wins. Blocking it would trap the user if Hello never answers, so this hook
 * discards a late biometric result instead: only the most recent `trigger`
 * can settle the state, and results arriving after unmount are dropped.
 *
 * ```tsx
 * const { pending, trigger, failure } = useBiometricUnlock({
 *   unlock: () => window.electronAPI.auth.biometricUnlock(),
 *   onUnlocked: () => navigate('/'),
 * })
 * ```
 */
function useBiometricUnlock(opts) {
    const { unlock, onUnlocked } = opts;
    const unlockRef = (0, react_1.useRef)(unlock);
    const onUnlockedRef = (0, react_1.useRef)(onUnlocked);
    (0, react_1.useEffect)(() => {
        unlockRef.current = unlock;
        onUnlockedRef.current = onUnlocked;
    }, [unlock, onUnlocked]);
    const [pending, setPending] = (0, react_1.useState)(false);
    const [failure, setFailure] = (0, react_1.useState)(null);
    // Generation token: only the newest attempt may settle state. Guards both
    // the double-click race and a result landing after unmount.
    const generationRef = (0, react_1.useRef)(0);
    const mountedRef = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            generationRef.current += 1;
        };
    }, []);
    const pendingRef = (0, react_1.useRef)(false);
    const trigger = (0, react_1.useCallback)(() => {
        if (pendingRef.current)
            return;
        pendingRef.current = true;
        generationRef.current += 1;
        const generation = generationRef.current;
        setPending(true);
        setFailure(null);
        void (async () => {
            let result;
            try {
                result = await unlockRef.current();
            }
            catch (err) {
                // An IPC-level failure is not a biometric verdict; surface it as a
                // refusal rather than letting it escape an event handler unhandled.
                // eslint-disable-next-line no-console
                console.error('[biometric] unlock call failed:', err);
                result = { ok: false, failure: 'rejected', reason: 'unknown' };
            }
            pendingRef.current = false;
            if (!mountedRef.current || generation !== generationRef.current)
                return;
            setPending(false);
            if (result.ok) {
                onUnlockedRef.current?.();
            }
            else {
                setFailure(result);
            }
        })();
    }, []);
    return { pending, trigger, failure };
}
//# sourceMappingURL=react.js.map