import type { CreateSessionServiceOpts, SessionState } from './types';
export declare const SESSION_FILENAME = "session.bin";
/**
 * v1: DPAPI-encrypted envelope (`{ version: 1, ciphertext }`). Could not be
 *     decrypted across apps because Electron's safeStorage uses a Master Key
 *     stored per-app in `userData/Local State`.
 * v2: Plain JSON (`{ version: 2, ...content }`). The session file lives in
 *     `%LOCALAPPDATA%` (per-user) with file permissions restricting access
 *     to the owner. Content is not sensitive (timestamps + opaque token +
 *     appId), so OS-level isolation is sufficient and the cross-app sharing
 *     becomes reliable.
 */
export declare const SESSION_FILE_VERSION = 2;
export declare const SESSION_FILE_VERSIONS_SUPPORTED: readonly number[];
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