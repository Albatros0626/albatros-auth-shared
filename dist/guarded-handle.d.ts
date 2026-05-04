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
export declare const NOT_UNLOCKED_ERROR: GuardedError;
export type GuardedHandle = (channel: string, listener: IpcHandler) => void;
export declare function createGuardedHandle(opts: CreateGuardedHandleOpts): GuardedHandle;
//# sourceMappingURL=guarded-handle.d.ts.map