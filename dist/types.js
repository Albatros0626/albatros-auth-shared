"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecretsVaultVersionUnsupportedError = exports.DPAPIUnavailableError = exports.KeyNotAllowedError = exports.VaultNotInitializedError = exports.VaultVersionUnsupportedError = void 0;
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
//# sourceMappingURL=types.js.map