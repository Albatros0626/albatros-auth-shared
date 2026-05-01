"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SECRETS_VAULT_VERSION = void 0;
exports.anonymizeKeyForLog = anonymizeKeyForLog;
exports.createSecretsService = createSecretsService;
const fs_1 = require("fs");
const types_1 = require("./types");
exports.SECRETS_VAULT_VERSION = 1;
function anonymizeKeyForLog(key) {
    if (!key)
        return '***';
    const idx = key.indexOf('.');
    if (idx === -1)
        return '***';
    return `${key.slice(0, idx)}.***`;
}
function createSecretsService(opts) {
    const { vaultPath, allowlist, safeStorage } = opts;
    const allowSet = new Set(allowlist);
    function readVault() {
        if (!(0, fs_1.existsSync)(vaultPath)) {
            return { version: exports.SECRETS_VAULT_VERSION, secrets: {} };
        }
        const raw = (0, fs_1.readFileSync)(vaultPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.version !== exports.SECRETS_VAULT_VERSION) {
            throw new types_1.SecretsVaultVersionUnsupportedError(parsed.version);
        }
        return parsed;
    }
    function writeVault(vault) {
        // Per-writer tmp suffix to avoid renameSync races between concurrent writers
        // (see session-service writeContent for the same rationale).
        const tmp = `${vaultPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        const content = JSON.stringify(vault, null, 2);
        try {
            (0, fs_1.writeFileSync)(tmp, content, { mode: 0o600 });
            try {
                (0, fs_1.chmodSync)(tmp, 0o600);
            }
            catch { /* best effort on non-POSIX */ }
            (0, fs_1.renameSync)(tmp, vaultPath);
        }
        catch (err) {
            try {
                if ((0, fs_1.existsSync)(tmp))
                    (0, fs_1.unlinkSync)(tmp);
            }
            catch { /* ignore */ }
            throw err;
        }
    }
    function assertAllowed(key) {
        if (!allowSet.has(key)) {
            throw new types_1.KeyNotAllowedError(key);
        }
    }
    function isAvailableImpl() {
        try {
            return safeStorage.isEncryptionAvailable();
        }
        catch {
            return false;
        }
    }
    return {
        isAvailable: isAvailableImpl,
        setSecret(key, value) {
            assertAllowed(key);
            if (!isAvailableImpl()) {
                throw new types_1.DPAPIUnavailableError();
            }
            const encrypted = safeStorage.encryptString(value);
            const vault = readVault();
            vault.secrets[key] = encrypted.toString('base64');
            writeVault(vault);
        },
        getSecret(key) {
            assertAllowed(key);
            if (!isAvailableImpl())
                return null;
            const vault = readVault();
            const b64 = vault.secrets[key];
            if (!b64)
                return null;
            try {
                const buf = Buffer.from(b64, 'base64');
                return safeStorage.decryptString(buf);
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.error(`[secrets] Failed to decrypt ${anonymizeKeyForLog(key)}:`, err);
                return null;
            }
        },
        hasSecret(key) {
            assertAllowed(key);
            const vault = readVault();
            return !!vault.secrets[key];
        },
        deleteSecret(key) {
            assertAllowed(key);
            const vault = readVault();
            if (vault.secrets[key]) {
                delete vault.secrets[key];
                writeVault(vault);
            }
        },
        __readVaultForTests() {
            return readVault();
        },
    };
}
//# sourceMappingURL=secrets-service.js.map