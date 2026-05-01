"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BACKUP_SUFFIX = void 0;
exports.appendMigrationLog = appendMigrationLog;
exports.detectMigrationConflict = detectMigrationConflict;
exports.migrateLocalAuthToShared = migrateLocalAuthToShared;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
exports.BACKUP_SUFFIX = '.migrated.bak';
function nowIso() {
    return new Date().toISOString();
}
function buildResult(outcome, message, appId, extra = {}) {
    return {
        outcome,
        message,
        appId,
        timestamp: nowIso(),
        ...extra,
    };
}
function appendMigrationLog(logPath, entry) {
    try {
        const dir = path_1.default.dirname(logPath);
        if (!(0, fs_1.existsSync)(dir))
            (0, fs_1.mkdirSync)(dir, { recursive: true });
        (0, fs_1.appendFileSync)(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    }
    catch (err) {
        // Logging failure is non-fatal: don't crash the migration over an audit issue
        // eslint-disable-next-line no-console
        console.error('[migration] failed to append log:', err);
    }
}
function logIfEnabled(opts, result) {
    if (opts.migrationLogPath) {
        appendMigrationLog(opts.migrationLogPath, result);
    }
}
/**
 * Returns true if both local and shared vaults exist — meaning the user had
 * setup separate auth on multiple apps before mutualization. The app should
 * surface a UX dialog letting the user pick which one to keep.
 */
function detectMigrationConflict(opts) {
    return (0, fs_1.existsSync)(opts.localVaultPath) && (0, fs_1.existsSync)(opts.sharedVaultPath);
}
/**
 * Idempotent one-shot migration of a per-app vault to the shared location.
 *
 * Outcomes:
 * - `no-op-fresh-install` — neither file exists; nothing to do
 * - `no-op-already-migrated` — shared exists, local missing; another app already migrated
 * - `migrated` — local copied to shared, original renamed to `.migrated.bak`
 * - `conflict-needs-resolution` — both exist; caller must surface UX (use `detectMigrationConflict` for clarity)
 * - `error` — local file unreadable or atomic write failed; no destructive operation took place
 *
 * Vault format conversion (v1 → v2 with `lockTimeoutMinutes`) is NOT performed
 * here — the auth-service handles it lazily on first read of the shared vault,
 * keeping migration concerns separate from format concerns.
 */
function migrateLocalAuthToShared(opts) {
    const { localVaultPath, sharedVaultPath, appId } = opts;
    const sharedExists = (0, fs_1.existsSync)(sharedVaultPath);
    const localExists = (0, fs_1.existsSync)(localVaultPath);
    if (!sharedExists && !localExists) {
        const result = buildResult('no-op-fresh-install', 'No vault to migrate (fresh install).', appId);
        logIfEnabled(opts, result);
        return result;
    }
    if (sharedExists && !localExists) {
        const result = buildResult('no-op-already-migrated', 'Shared vault already exists; local already migrated by another app.', appId);
        logIfEnabled(opts, result);
        return result;
    }
    if (sharedExists && localExists) {
        const result = buildResult('conflict-needs-resolution', 'Both shared and local vaults exist; user must choose which to keep.', appId);
        logIfEnabled(opts, result);
        return result;
    }
    // Local exists, shared does not → perform migration
    let content;
    try {
        content = (0, fs_1.readFileSync)(localVaultPath, 'utf-8');
        JSON.parse(content); // sanity-check that it parses
    }
    catch (err) {
        const result = buildResult('error', `Local vault unreadable: ${err.message}`, appId);
        logIfEnabled(opts, result);
        return result;
    }
    // Atomic write to shared location
    const sharedDir = path_1.default.dirname(sharedVaultPath);
    if (!(0, fs_1.existsSync)(sharedDir)) {
        try {
            (0, fs_1.mkdirSync)(sharedDir, { recursive: true });
        }
        catch (err) {
            const result = buildResult('error', `Failed to create shared dir: ${err.message}`, appId);
            logIfEnabled(opts, result);
            return result;
        }
    }
    const tmp = `${sharedVaultPath}.tmp`;
    try {
        (0, fs_1.writeFileSync)(tmp, content, { mode: 0o600 });
        (0, fs_1.renameSync)(tmp, sharedVaultPath);
    }
    catch (err) {
        try {
            if ((0, fs_1.existsSync)(tmp))
                (0, fs_1.unlinkSync)(tmp);
        }
        catch { /* ignore */ }
        const result = buildResult('error', `Failed to write shared vault: ${err.message}`, appId);
        logIfEnabled(opts, result);
        return result;
    }
    // Shared write succeeded; rename local → .bak (best-effort but logged)
    const backupPath = `${localVaultPath}${exports.BACKUP_SUFFIX}`;
    try {
        (0, fs_1.renameSync)(localVaultPath, backupPath);
    }
    catch (err) {
        // Shared was written but local backup failed — on next run, conflict
        // will be detected (both exist) and the user can resolve via UX.
        const result = buildResult('error', `Shared vault written but local backup failed: ${err.message}`, appId);
        logIfEnabled(opts, result);
        return result;
    }
    const result = buildResult('migrated', 'Local vault successfully migrated to shared location and original backed up.', appId, { backupPath });
    logIfEnabled(opts, result);
    return result;
}
//# sourceMappingURL=migration.js.map