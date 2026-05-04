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
/** Default DOM events watched. Same set used by all 3 consumer apps. */
export declare const DEFAULT_ACTIVITY_EVENTS: ReadonlyArray<string>;
export declare const DEFAULT_IPC_THROTTLE_MS = 1000;
/**
 * Structural type for an event target — `Window` and any test stub fit.
 * Avoids forcing the package's tsconfig to include the DOM lib.
 */
export interface ActivityEventTarget {
    addEventListener(event: string, listener: () => void, options?: {
        passive?: boolean;
    }): void;
    removeEventListener(event: string, listener: () => void): void;
}
export interface AttachActivityTrackingOpts {
    /** Where to attach the DOM listeners. Pass `window` from the renderer. */
    target: ActivityEventTarget;
    /** Idle timeout in milliseconds. */
    timeoutMs: number;
    /** Fired after `timeoutMs` without any tracked event. */
    onIdle: () => void;
    /** Fired on each tracked event, throttled to `throttleMs`. Optional. */
    onActivity?: () => void;
    /** Events to listen for. Default: mouse + keyboard + wheel + touch. */
    events?: ReadonlyArray<string>;
    /** Throttle for `onActivity` (default 1000ms). The internal idle tracker is unaffected. */
    throttleMs?: number;
}
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
export declare function attachActivityTracking(opts: AttachActivityTrackingOpts): () => void;
//# sourceMappingURL=activity-listener.d.ts.map