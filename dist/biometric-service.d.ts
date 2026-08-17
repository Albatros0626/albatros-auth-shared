import type { BiometricUnlockResult, CreateBiometricServiceOpts } from './types';
export declare const BIOMETRIC_BLOB_VERSION = 1;
export declare const SUPPORTED_BIOMETRIC_BLOB_VERSIONS: readonly number[];
export declare const DEFAULT_BIOMETRIC_KEY_NAME = "AlbatrosAuthShared";
/**
 * Biometric (Windows Hello) unlock.
 *
 * The design rule that makes this safe: **Hello never replaces verification,
 * it restores the factor.** The Hello signature decrypts the stored app code,
 * which is then fed to the ordinary `verifyCode()` — so PBKDF2, constant-time
 * comparison and the lockout counter all still apply, and there is exactly one
 * path that can declare the app unlocked.
 *
 * The stored blob is therefore a plaintext-equivalent of the code, protected
 * by the TPM (the key never leaves it and is only usable after a Hello
 * verification) and by AES-256-GCM. That trade-off is what lets us keep a
 * single source of truth without bumping the shared vault to v3.
 */
export interface BiometricService {
    /** Whether the platform can do Hello at all. Async: probes the OS. */
    isSupported(): Promise<boolean>;
    /**
     * Whether a usable enrolment exists. Synchronous file check — cheap enough
     * to gate a button on every render, unlike `isSupported()`.
     */
    isEnrolled(): boolean;
    /** Enrols after validating `code`. All-or-nothing: failure leaves no trace. */
    enroll(code: string, hwnd: Buffer): Promise<void>;
    /** Prompts Hello and, on success, unlocks through `verifyCode()`. */
    unlock(hwnd: Buffer): Promise<BiometricUnlockResult>;
    /** Revokes the enrolment: removes the blob, then the Hello key. */
    disable(): Promise<void>;
}
export declare function createBiometricService(opts: CreateBiometricServiceOpts): BiometricService;
//# sourceMappingURL=biometric-service.d.ts.map