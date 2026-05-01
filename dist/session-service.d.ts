import type { CreateSessionServiceOpts, SessionState } from './types';
export declare const SESSION_FILENAME = "session.bin";
export declare const SESSION_FILE_VERSION = 1;
export declare const DEFAULT_ACTIVITY_THROTTLE_MS = 10000;
export declare const DEFAULT_WATCH_DEBOUNCE_MS = 100;
export interface SessionService {
    read(): SessionState | null;
    recordUnlock(opts: {
        lockTimeoutMinutes: number;
    }): SessionState;
    recordLock(): void;
    recordActivity(): void;
    watch(cb: (state: SessionState | null) => void): () => void;
    /** @internal Flush any pending throttled writes. Test-only. */
    __flushPendingForTests(): void;
}
export declare function createSessionService(opts: CreateSessionServiceOpts): SessionService;
//# sourceMappingURL=session-service.d.ts.map