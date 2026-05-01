"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_LOCK_TIMEOUT_MINUTES = exports.DELAY_MAX_SECONDS = exports.DELAY_START_AT_ATTEMPT = exports.LOCKOUT_DURATION_MS = exports.LOCKOUT_THRESHOLD = exports.SUPPORTED_VAULT_VERSIONS = exports.VAULT_VERSION = exports.CODE_MIN_LENGTH = exports.SALT_LENGTH = exports.PBKDF2_DIGEST = exports.PBKDF2_KEYLEN = exports.PBKDF2_ITERATIONS = void 0;
exports.normalizeAnswer = normalizeAnswer;
exports.validateCode = validateCode;
exports.createAuthService = createAuthService;
const util_1 = require("util");
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const recovery_questions_1 = require("./recovery-questions");
const types_1 = require("./types");
const pbkdf2Async = (0, util_1.promisify)(crypto_1.pbkdf2);
exports.PBKDF2_ITERATIONS = 600_000;
exports.PBKDF2_KEYLEN = 64;
exports.PBKDF2_DIGEST = 'sha512';
exports.SALT_LENGTH = 16;
exports.CODE_MIN_LENGTH = 6;
exports.VAULT_VERSION = 2;
exports.SUPPORTED_VAULT_VERSIONS = [1, 2];
exports.LOCKOUT_THRESHOLD = 5;
exports.LOCKOUT_DURATION_MS = 30 * 60 * 1000;
exports.DELAY_START_AT_ATTEMPT = 3;
exports.DELAY_MAX_SECONDS = 30;
exports.DEFAULT_LOCK_TIMEOUT_MINUTES = 10;
const TRIVIAL_PATTERNS = [
    '123456', '234567', '345678', '456789', '567890', '654321',
    'qwerty', 'azerty', 'abcdef',
];
function normalizeAnswer(s) {
    return s
        .normalize('NFD')
        // eslint-disable-next-line no-misleading-character-class
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}
async function derive(secret, salt) {
    return pbkdf2Async(secret, salt, exports.PBKDF2_ITERATIONS, exports.PBKDF2_KEYLEN, exports.PBKDF2_DIGEST);
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return (0, crypto_1.timingSafeEqual)(a, b);
}
function computeDelaySeconds(attempts) {
    if (attempts < exports.DELAY_START_AT_ATTEMPT)
        return 0;
    const delay = 2 ** (attempts - (exports.DELAY_START_AT_ATTEMPT - 1));
    return Math.min(exports.DELAY_MAX_SECONDS, delay);
}
function isTrivialCode(code) {
    const lower = code.toLowerCase();
    if (TRIVIAL_PATTERNS.includes(lower))
        return true;
    if (new Set(lower).size === 1)
        return true;
    if (/^\d+$/.test(code) && code.length >= 6) {
        const digits = code.split('').map(Number);
        const asc = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
        const desc = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
        if (asc || desc)
            return true;
    }
    return false;
}
function validateCode(code) {
    if (code.length < exports.CODE_MIN_LENGTH) {
        return { valid: false, reason: `Minimum ${exports.CODE_MIN_LENGTH} caractères` };
    }
    if (isTrivialCode(code)) {
        return { valid: false, reason: 'Code trop simple (suite ou répétition)' };
    }
    return { valid: true };
}
function createAuthService(opts) {
    const { vaultPath } = opts;
    function readVault() {
        if (!(0, fs_1.existsSync)(vaultPath))
            return null;
        const raw = (0, fs_1.readFileSync)(vaultPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!exports.SUPPORTED_VAULT_VERSIONS.includes(parsed.version)) {
            throw new types_1.VaultVersionUnsupportedError(parsed.version, exports.SUPPORTED_VAULT_VERSIONS);
        }
        if (parsed.version === 1) {
            return migrateV1ToV2(parsed);
        }
        return parsed;
    }
    function migrateV1ToV2(legacy) {
        const migrated = {
            ...legacy,
            version: 2,
            schemaCompat: [1, 2],
            lockTimeoutMinutes: exports.DEFAULT_LOCK_TIMEOUT_MINUTES,
        };
        writeVault(migrated);
        return migrated;
    }
    function writeVault(vault) {
        (0, fs_1.writeFileSync)(vaultPath, JSON.stringify(vault, null, 2), { mode: 0o600 });
        try {
            (0, fs_1.chmodSync)(vaultPath, 0o600);
        }
        catch { /* best effort on non-POSIX */ }
    }
    function requireVault() {
        const v = readVault();
        if (!v)
            throw new types_1.VaultNotInitializedError();
        return v;
    }
    return {
        isSetupComplete() {
            return (0, fs_1.existsSync)(vaultPath);
        },
        async setup({ code, recoveryQuestion, recoveryAnswer }) {
            if ((0, fs_1.existsSync)(vaultPath)) {
                throw new Error('Setup already complete');
            }
            const codeCheck = validateCode(code);
            if (!codeCheck.valid) {
                throw new Error(codeCheck.reason);
            }
            if (!recoveryQuestion.trim() || recoveryQuestion.trim().length < recovery_questions_1.CUSTOM_QUESTION_MIN_LENGTH) {
                throw new Error(`Question trop courte (minimum ${recovery_questions_1.CUSTOM_QUESTION_MIN_LENGTH} caractères)`);
            }
            const normalizedAnswer = normalizeAnswer(recoveryAnswer);
            if (normalizedAnswer.length < recovery_questions_1.RECOVERY_ANSWER_MIN_LENGTH) {
                throw new Error(`Réponse trop courte (minimum ${recovery_questions_1.RECOVERY_ANSWER_MIN_LENGTH} caractères)`);
            }
            const saltCode = (0, crypto_1.randomBytes)(exports.SALT_LENGTH);
            const saltRecovery = (0, crypto_1.randomBytes)(exports.SALT_LENGTH);
            const hashCode = await derive(code, saltCode);
            const hashRecovery = await derive(normalizedAnswer, saltRecovery);
            const now = new Date().toISOString();
            const vault = {
                version: exports.VAULT_VERSION,
                schemaCompat: [1, 2],
                created_at: now,
                last_code_change: now,
                pbkdf2_iterations: exports.PBKDF2_ITERATIONS,
                salt_code: saltCode.toString('base64'),
                hash_code: hashCode.toString('base64'),
                salt_recovery: saltRecovery.toString('base64'),
                recovery_question: recoveryQuestion.trim(),
                hash_recovery: hashRecovery.toString('base64'),
                failed_attempts: 0,
                lockout_until: null,
                lockTimeoutMinutes: exports.DEFAULT_LOCK_TIMEOUT_MINUTES,
            };
            writeVault(vault);
        },
        async verifyCode(code) {
            const vault = requireVault();
            // Anti timing-attack: derive ALWAYS, even if code too short or lockout active.
            const codeForDerivation = code.length > 0 ? code : ' ';
            const hashCandidate = await derive(codeForDerivation, Buffer.from(vault.salt_code, 'base64'));
            const hashStored = Buffer.from(vault.hash_code, 'base64');
            if (code.length < exports.CODE_MIN_LENGTH)
                return false;
            if (vault.lockout_until && new Date(vault.lockout_until).getTime() > Date.now()) {
                return false;
            }
            if (constantTimeEqual(hashCandidate, hashStored)) {
                vault.failed_attempts = 0;
                vault.lockout_until = null;
                writeVault(vault);
                return true;
            }
            vault.failed_attempts += 1;
            if (vault.failed_attempts >= exports.LOCKOUT_THRESHOLD) {
                vault.lockout_until = new Date(Date.now() + exports.LOCKOUT_DURATION_MS).toISOString();
            }
            writeVault(vault);
            return false;
        },
        async verifyCurrentCode(code) {
            const vault = requireVault();
            const hashCandidate = await derive(code, Buffer.from(vault.salt_code, 'base64'));
            const hashStored = Buffer.from(vault.hash_code, 'base64');
            return constantTimeEqual(hashCandidate, hashStored);
        },
        async testRecovery(answer) {
            const vault = requireVault();
            const normalized = normalizeAnswer(answer);
            const hashCandidate = await derive(normalized, Buffer.from(vault.salt_recovery, 'base64'));
            const hashStored = Buffer.from(vault.hash_recovery, 'base64');
            return constantTimeEqual(hashCandidate, hashStored);
        },
        async recover(answer, newCode) {
            const vault = requireVault();
            if (vault.lockout_until && new Date(vault.lockout_until).getTime() > Date.now()) {
                throw new Error('Application verrouillée, réessayez plus tard');
            }
            const codeCheck = validateCode(newCode);
            if (!codeCheck.valid) {
                throw new Error(codeCheck.reason);
            }
            const normalized = normalizeAnswer(answer);
            const hashCandidate = await derive(normalized, Buffer.from(vault.salt_recovery, 'base64'));
            const hashStored = Buffer.from(vault.hash_recovery, 'base64');
            if (!constantTimeEqual(hashCandidate, hashStored)) {
                vault.failed_attempts += 1;
                if (vault.failed_attempts >= exports.LOCKOUT_THRESHOLD) {
                    vault.lockout_until = new Date(Date.now() + exports.LOCKOUT_DURATION_MS).toISOString();
                }
                writeVault(vault);
                throw new Error('Réponse incorrecte');
            }
            const saltCode = (0, crypto_1.randomBytes)(exports.SALT_LENGTH);
            const hashCode = await derive(newCode, saltCode);
            vault.salt_code = saltCode.toString('base64');
            vault.hash_code = hashCode.toString('base64');
            vault.last_code_change = new Date().toISOString();
            vault.failed_attempts = 0;
            vault.lockout_until = null;
            writeVault(vault);
        },
        async changeCode(oldCode, newCode) {
            const vault = requireVault();
            const oldHash = await derive(oldCode, Buffer.from(vault.salt_code, 'base64'));
            const stored = Buffer.from(vault.hash_code, 'base64');
            if (!constantTimeEqual(oldHash, stored)) {
                throw new Error('Ancien code incorrect');
            }
            const codeCheck = validateCode(newCode);
            if (!codeCheck.valid) {
                throw new Error(codeCheck.reason);
            }
            const saltCode = (0, crypto_1.randomBytes)(exports.SALT_LENGTH);
            const hashCode = await derive(newCode, saltCode);
            vault.salt_code = saltCode.toString('base64');
            vault.hash_code = hashCode.toString('base64');
            vault.last_code_change = new Date().toISOString();
            writeVault(vault);
        },
        async changeRecovery(currentCode, newQuestion, newAnswer) {
            const vault = requireVault();
            const candidate = await derive(currentCode, Buffer.from(vault.salt_code, 'base64'));
            const stored = Buffer.from(vault.hash_code, 'base64');
            if (!constantTimeEqual(candidate, stored)) {
                throw new Error('Code actuel incorrect');
            }
            if (!newQuestion.trim() || newQuestion.trim().length < recovery_questions_1.CUSTOM_QUESTION_MIN_LENGTH) {
                throw new Error(`Question trop courte (minimum ${recovery_questions_1.CUSTOM_QUESTION_MIN_LENGTH} caractères)`);
            }
            const normalized = normalizeAnswer(newAnswer);
            if (normalized.length < recovery_questions_1.RECOVERY_ANSWER_MIN_LENGTH) {
                throw new Error(`Réponse trop courte (minimum ${recovery_questions_1.RECOVERY_ANSWER_MIN_LENGTH} caractères)`);
            }
            const saltRecovery = (0, crypto_1.randomBytes)(exports.SALT_LENGTH);
            const hashRecovery = await derive(normalized, saltRecovery);
            vault.salt_recovery = saltRecovery.toString('base64');
            vault.recovery_question = newQuestion.trim();
            vault.hash_recovery = hashRecovery.toString('base64');
            writeVault(vault);
        },
        getRecoveryQuestion() {
            const vault = requireVault();
            return vault.recovery_question;
        },
        getLastCodeChangeDate() {
            const vault = readVault();
            if (!vault)
                return null;
            return vault.last_code_change;
        },
        getLockoutStatus() {
            const vault = readVault();
            if (!vault) {
                return { locked_until: null, attempts_remaining: exports.LOCKOUT_THRESHOLD, required_delay_seconds: 0 };
            }
            const now = Date.now();
            const lockedUntil = vault.lockout_until && new Date(vault.lockout_until).getTime() > now
                ? vault.lockout_until
                : null;
            const attemptsRemaining = Math.max(0, exports.LOCKOUT_THRESHOLD - vault.failed_attempts);
            const requiredDelay = lockedUntil ? 0 : computeDelaySeconds(vault.failed_attempts);
            return {
                locked_until: lockedUntil,
                attempts_remaining: attemptsRemaining,
                required_delay_seconds: requiredDelay,
            };
        },
        getLockTimeoutMinutes() {
            const vault = readVault();
            if (!vault)
                return exports.DEFAULT_LOCK_TIMEOUT_MINUTES;
            return vault.lockTimeoutMinutes;
        },
        setLockTimeoutMinutes(minutes) {
            if (!Number.isInteger(minutes) || minutes < 0) {
                throw new Error('lockTimeoutMinutes must be a non-negative integer');
            }
            const vault = requireVault();
            vault.lockTimeoutMinutes = minutes;
            writeVault(vault);
        },
    };
}
//# sourceMappingURL=auth-service.js.map