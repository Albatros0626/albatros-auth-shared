export declare const BACKUP_SUFFIX = ".migrated.bak";
export type MigrationOutcome = 'no-op-fresh-install' | 'no-op-already-migrated' | 'migrated' | 'conflict-needs-resolution' | 'error';
export interface MigrationResult {
    outcome: MigrationOutcome;
    message: string;
    appId: string;
    timestamp: string;
    backupPath?: string;
}
export interface MigrateLocalAuthToSharedOpts {
    /** Path to the per-app legacy auth vault. */
    localVaultPath: string;
    /** Path to the shared auth vault under %LOCALAPPDATA%\AlbatrosApps. */
    sharedVaultPath: string;
    /** Identifier of the app triggering migration (for audit log). */
    appId: string;
    /** Optional JSONL log file. If provided, every migration result is appended. */
    migrationLogPath?: string;
}
export interface DetectMigrationConflictOpts {
    localVaultPath: string;
    sharedVaultPath: string;
}
export declare function appendMigrationLog(logPath: string, entry: MigrationResult): void;
/**
 * Returns true if both local and shared vaults exist — meaning the user had
 * setup separate auth on multiple apps before mutualization. The app should
 * surface a UX dialog letting the user pick which one to keep.
 */
export declare function detectMigrationConflict(opts: DetectMigrationConflictOpts): boolean;
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
export declare function migrateLocalAuthToShared(opts: MigrateLocalAuthToSharedOpts): MigrationResult;
//# sourceMappingURL=migration.d.ts.map