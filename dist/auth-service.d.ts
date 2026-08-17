import type { CreateAuthServiceOpts, LockoutStatus, SetupOpts } from './types';
export declare const PBKDF2_ITERATIONS = 600000;
export declare const PBKDF2_KEYLEN = 64;
export declare const PBKDF2_DIGEST = "sha512";
export declare const SALT_LENGTH = 16;
export declare const CODE_MIN_LENGTH = 6;
export declare const VAULT_VERSION = 2;
export declare const SUPPORTED_VAULT_VERSIONS: readonly number[];
export declare const LOCKOUT_THRESHOLD = 5;
export declare const LOCKOUT_DURATION_MS: number;
export declare const DELAY_START_AT_ATTEMPT = 3;
export declare const DELAY_MAX_SECONDS = 30;
export declare const DEFAULT_LOCK_TIMEOUT_MINUTES = 10;
export declare function normalizeAnswer(s: string): string;
export declare function validateCode(code: string): {
    valid: boolean;
    reason?: string;
};
/**
 * Every method that checks a user-supplied secret — the code or the recovery
 * answer — honours the lockout window and counts its failures. There is no
 * "quiet" verification path.
 *
 * That uniformity is deliberate and was learned the hard way. Until v3.0.0,
 * `verifyCurrentCode`, `testRecovery`, `changeCode` and `changeRecovery`
 * compared secrets without touching `failed_attempts` or `lockout_until`, on
 * the assumption that callers would only reach them from an already-unlocked
 * context. All three Albatros apps broke that assumption by exposing them on
 * unguarded IPC channels, turning each into an unthrottled brute-force oracle
 * that bypassed the five attempts protecting `verifyCode`.
 *
 * The fix is deliberately structural rather than nominal: renaming them
 * (`verifyCurrentCodeUnthrottled`…) would have made the hazard visible while
 * leaving it callable, and would have protected only the apps that took the
 * update. Making the guarantee intrinsic protects every caller, including the
 * ones whose IPC wiring stays imperfect.
 *
 * Cost of that choice, accepted knowingly: mistyping the current code five
 * times inside a settings dialog now locks the vault for 30 minutes, exactly
 * as it does on the lock screen.
 */
export interface AuthService {
    isSetupComplete(): boolean;
    setup(opts: SetupOpts): Promise<void>;
    /** Unlock path. Counts failures, refuses during lockout. */
    verifyCode(code: string): Promise<boolean>;
    /**
     * Confirms the current code (settings flows). Counts failures and throws
     * {@link VaultLockedOutError} during lockout — same policy as `verifyCode`.
     */
    verifyCurrentCode(code: string): Promise<boolean>;
    /**
     * Checks the recovery answer without consuming it. Counts failures and
     * throws {@link VaultLockedOutError} during lockout.
     */
    testRecovery(answer: string): Promise<boolean>;
    recover(answer: string, newCode: string): Promise<void>;
    /** A wrong `oldCode` counts as a failed attempt. */
    changeCode(oldCode: string, newCode: string): Promise<void>;
    /** A wrong `currentCode` counts as a failed attempt. */
    changeRecovery(currentCode: string, newQuestion: string, newAnswer: string): Promise<void>;
    getRecoveryQuestion(): string;
    getLastCodeChangeDate(): string | null;
    getLockoutStatus(): LockoutStatus;
    getLockTimeoutMinutes(): number;
    setLockTimeoutMinutes(minutes: number): void;
}
export declare function createAuthService(opts: CreateAuthServiceOpts): AuthService;
//# sourceMappingURL=auth-service.d.ts.map