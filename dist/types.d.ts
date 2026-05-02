export interface LockoutStatus {
    locked_until: string | null;
    attempts_remaining: number;
    required_delay_seconds: number;
}
export interface AuthVault {
    version: number;
    schemaCompat: number[];
    created_at: string;
    last_code_change: string;
    pbkdf2_iterations: number;
    salt_code: string;
    hash_code: string;
    salt_recovery: string;
    recovery_question: string;
    hash_recovery: string;
    failed_attempts: number;
    lockout_until: string | null;
    lockTimeoutMinutes: number;
}
export interface SetupOpts {
    code: string;
    recoveryQuestion: string;
    recoveryAnswer: string;
}
export interface CreateAuthServiceOpts {
    vaultPath: string;
}
export declare class VaultVersionUnsupportedError extends Error {
    readonly code = "VAULT_VERSION_UNSUPPORTED";
    readonly vaultVersion: number;
    readonly supportedVersions: readonly number[];
    constructor(vaultVersion: number, supportedVersions: readonly number[]);
}
export declare class VaultNotInitializedError extends Error {
    readonly code = "VAULT_NOT_INITIALIZED";
    constructor();
}
export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(encrypted: Buffer): string;
}
export interface SecretsVault {
    version: number;
    secrets: Record<string, string>;
}
export interface CreateSecretsServiceOpts {
    vaultPath: string;
    allowlist: readonly string[];
    safeStorage: SafeStorageLike;
}
export declare class KeyNotAllowedError extends Error {
    readonly code = "KEY_NOT_ALLOWED";
    readonly key: string;
    constructor(key: string);
}
export declare class DPAPIUnavailableError extends Error {
    readonly code = "DPAPI_UNAVAILABLE";
    constructor();
}
export declare class SecretsVaultVersionUnsupportedError extends Error {
    readonly code = "SECRETS_VAULT_VERSION_UNSUPPORTED";
    readonly vaultVersion: number;
    constructor(vaultVersion: number);
}
export interface SessionContent {
    unlockedAt: string;
    lastActivityAt: string;
    lockTimeoutMinutes: number;
    lockedAt: string | null;
    unlockerAppId: string;
    sessionToken: string;
}
export interface SessionState extends SessionContent {
    /** True if `now - lastActivityAt > lockTimeoutMinutes`. */
    isExpired: boolean;
    /** True if `lockedAt !== null`. */
    isLocked: boolean;
    /** True iff `!isLocked && !isExpired`. */
    isValid: boolean;
}
export interface SessionFileEnvelope {
    version: number;
    ciphertext: string;
}
export interface CreateSessionServiceOpts {
    sharedDir: string;
    appId: string;
    /**
     * @deprecated since v1.1.3. session.bin is no longer DPAPI-encrypted because
     * Electron's safeStorage Master Key is per-app and cannot decrypt files
     * written by another app. The session file is now plain JSON in
     * %LOCALAPPDATA% (per-user, restricted by file permissions). Accepted for
     * backwards compat but unused; pass `undefined` or omit.
     */
    safeStorage?: SafeStorageLike;
    /** Activity write throttle in ms (default 10_000). Test-only override. */
    activityThrottleMs?: number;
    /** Watch event debounce in ms (default 100). Test-only override. */
    watchDebounceMs?: number;
}
//# sourceMappingURL=types.d.ts.map