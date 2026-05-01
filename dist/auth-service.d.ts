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
export interface AuthService {
    isSetupComplete(): boolean;
    setup(opts: SetupOpts): Promise<void>;
    verifyCode(code: string): Promise<boolean>;
    verifyCurrentCode(code: string): Promise<boolean>;
    testRecovery(answer: string): Promise<boolean>;
    recover(answer: string, newCode: string): Promise<void>;
    changeCode(oldCode: string, newCode: string): Promise<void>;
    changeRecovery(currentCode: string, newQuestion: string, newAnswer: string): Promise<void>;
    getRecoveryQuestion(): string;
    getLastCodeChangeDate(): string | null;
    getLockoutStatus(): LockoutStatus;
    getLockTimeoutMinutes(): number;
    setLockTimeoutMinutes(minutes: number): void;
}
export declare function createAuthService(opts: CreateAuthServiceOpts): AuthService;
//# sourceMappingURL=auth-service.d.ts.map