"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BiometricNonDeterministicError = exports.BiometricCodeRejectedError = exports.BiometricUnavailableError = exports.BIOMETRIC_REJECTION_REASONS = exports.SecretsVaultVersionUnsupportedError = exports.DPAPIUnavailableError = exports.KeyNotAllowedError = exports.VaultNotInitializedError = exports.VaultVersionUnsupportedError = void 0;
class VaultVersionUnsupportedError extends Error {
    code = 'VAULT_VERSION_UNSUPPORTED';
    vaultVersion;
    supportedVersions;
    constructor(vaultVersion, supportedVersions) {
        super(`Auth vault version ${vaultVersion} is not supported by this build. ` +
            `Supported versions: ${supportedVersions.join(', ')}. ` +
            `The app may need updating.`);
        this.name = 'VaultVersionUnsupportedError';
        this.vaultVersion = vaultVersion;
        this.supportedVersions = supportedVersions;
    }
}
exports.VaultVersionUnsupportedError = VaultVersionUnsupportedError;
class VaultNotInitializedError extends Error {
    code = 'VAULT_NOT_INITIALIZED';
    constructor() {
        super('Vault not initialized');
        this.name = 'VaultNotInitializedError';
    }
}
exports.VaultNotInitializedError = VaultNotInitializedError;
class KeyNotAllowedError extends Error {
    code = 'KEY_NOT_ALLOWED';
    key;
    constructor(key) {
        super(`Secret key not in allowlist: ${key}`);
        this.name = 'KeyNotAllowedError';
        this.key = key;
    }
}
exports.KeyNotAllowedError = KeyNotAllowedError;
class DPAPIUnavailableError extends Error {
    code = 'DPAPI_UNAVAILABLE';
    constructor() {
        super('Secret storage unavailable (safeStorage not ready)');
        this.name = 'DPAPIUnavailableError';
    }
}
exports.DPAPIUnavailableError = DPAPIUnavailableError;
class SecretsVaultVersionUnsupportedError extends Error {
    code = 'SECRETS_VAULT_VERSION_UNSUPPORTED';
    vaultVersion;
    constructor(vaultVersion) {
        super(`Secrets vault version ${vaultVersion} is not supported.`);
        this.name = 'SecretsVaultVersionUnsupportedError';
        this.vaultVersion = vaultVersion;
    }
}
exports.SecretsVaultVersionUnsupportedError = SecretsVaultVersionUnsupportedError;
/**
 * Why the platform refused a Hello operation. The native provider maps
 * HRESULTs to these; TypeScript never sees an HRESULT.
 *
 * Surfaced so the UI can stay quiet on a deliberate `cancelled` but say
 * something useful on `device-locked` — the two need opposite treatment.
 */
exports.BIOMETRIC_REJECTION_REASONS = [
    'cancelled',
    'retries-exhausted',
    'device-locked',
    'not-found',
];
class BiometricUnavailableError extends Error {
    code = 'BIOMETRIC_UNAVAILABLE';
    constructor(message = 'Windows Hello indisponible sur ce poste') {
        super(message);
        this.name = 'BiometricUnavailableError';
    }
}
exports.BiometricUnavailableError = BiometricUnavailableError;
class BiometricCodeRejectedError extends Error {
    code = 'BIOMETRIC_CODE_REJECTED';
    constructor() {
        super('Code incorrect — enrôlement biométrique refusé');
        this.name = 'BiometricCodeRejectedError';
    }
}
exports.BiometricCodeRejectedError = BiometricCodeRejectedError;
/**
 * Raised when the platform's Hello key does not sign deterministically, which
 * makes the whole envelope unusable. Determinism was measured on one machine;
 * another TPM could sign with a randomised scheme (RSA-PSS), and without this
 * check enrolment would silently produce a blob that never decrypts.
 */
class BiometricNonDeterministicError extends Error {
    code = 'BIOMETRIC_NON_DETERMINISTIC';
    constructor() {
        super('Windows Hello produit des signatures non déterministes sur ce poste ; ' +
            'le déverrouillage biométrique ne peut pas être activé.');
        this.name = 'BiometricNonDeterministicError';
    }
}
exports.BiometricNonDeterministicError = BiometricNonDeterministicError;
//# sourceMappingURL=types.js.map