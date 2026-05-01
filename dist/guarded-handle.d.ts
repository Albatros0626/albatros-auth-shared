import type { AuthState } from './auth-state';
export type IpcHandler = (event: any, ...args: any[]) => any;
export interface IpcMainLike {
    handle(channel: string, listener: IpcHandler): void;
}
export interface CreateGuardedHandleOpts {
    ipcMain: IpcMainLike;
    authState: AuthState;
}
export interface GuardedError {
    success: false;
    error: {
        code: 'NOT_UNLOCKED';
        message: string;
    };
}
export declare const NOT_UNLOCKED_ERROR: GuardedError;
export type GuardedHandle = (channel: string, listener: IpcHandler) => void;
export declare function createGuardedHandle(opts: CreateGuardedHandleOpts): GuardedHandle;
//# sourceMappingURL=guarded-handle.d.ts.map