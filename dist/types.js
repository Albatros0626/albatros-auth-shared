"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultNotInitializedError = exports.VaultVersionUnsupportedError = void 0;
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
//# sourceMappingURL=types.js.map