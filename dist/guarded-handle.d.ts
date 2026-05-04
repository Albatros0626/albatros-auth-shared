import type { AuthState } from './auth-state';
import type { GuardedError } from './guarded-error-types';
export type { GuardedError };
export { isGuardedError } from './guarded-error-types';
export type IpcHandler = (event: any, ...args: any[]) => any;
export interface IpcMainLike {
    handle(channel: string, listener: IpcHandler): void;
}
export interface CreateGuardedHandleOpts {
    ipcMain: IpcMainLike;
    authState: AuthState;
}
/**
 * Thrown by `guardedHandle` when an IPC call hits a locked app. Electron
 * serializes thrown errors back to the renderer as a rejected promise with
 * `name` preserved — use `isNotUnlockedError(err)` (browser subpath) to
 * detect this case in a `try/catch`.
 *
 * @since v2.0.0 (replaces the v1.x `NOT_UNLOCKED_ERROR` envelope return).
 */
export declare class NotUnlockedError extends Error {
    readonly code: "NOT_UNLOCKED";
    constructor(message?: string);
}
/**
 * @deprecated since v2.0.0 — `guardedHandle` now throws `NotUnlockedError`
 * instead of returning this envelope. Kept exported for back-compat of imports
 * from v1.x consumers; a future v3.0.0 may remove it.
 */
export declare const NOT_UNLOCKED_ERROR: GuardedError;
export type GuardedHandle = (channel: string, listener: IpcHandler) => void;
export declare function createGuardedHandle(opts: CreateGuardedHandleOpts): GuardedHandle;
//# sourceMappingURL=guarded-handle.d.ts.map