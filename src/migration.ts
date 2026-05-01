import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  appendFileSync,
  mkdirSync,
} from 'fs'
import path from 'path'

export const BACKUP_SUFFIX = '.migrated.bak'

export type MigrationOutcome =
  | 'no-op-fresh-install'
  | 'no-op-already-migrated'
  | 'migrated'
  | 'conflict-needs-resolution'
  | 'error'

export interface MigrationResult {
  outcome: MigrationOutcome
  message: string
  appId: string
  timestamp: string
  backupPath?: string
}

export interface MigrateLocalAuthToSharedOpts {
  /** Path to the per-app legacy auth vault. */
  localVaultPath: string
  /** Path to the shared auth vault under %LOCALAPPDATA%\AlbatrosApps. */
  sharedVaultPath: string
  /** Identifier of the app triggering migration (for audit log). */
  appId: string
  /** Optional JSONL log file. If provided, every migration result is appended. */
  migrationLogPath?: string
}

export interface DetectMigrationConflictOpts {
  localVaultPath: string
  sharedVaultPath: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function buildResult(
  outcome: MigrationOutcome,
  message: string,
  appId: string,
  extra: { backupPath?: string } = {},
): MigrationResult {
  return {
    outcome,
    message,
    appId,
    timestamp: nowIso(),
    ...extra,
  }
}

export function appendMigrationLog(logPath: string, entry: MigrationResult): void {
  try {
    const dir = path.dirname(logPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 })
  } catch (err) {
    // Logging failure is non-fatal: don't crash the migration over an audit issue
    // eslint-disable-next-line no-console
    console.error('[migration] failed to append log:', err)
  }
}

function logIfEnabled(opts: MigrateLocalAuthToSharedOpts, result: MigrationResult): void {
  if (opts.migrationLogPath) {
    appendMigrationLog(opts.migrationLogPath, result)
  }
}

/**
 * Returns true if both local and shared vaults exist — meaning the user had
 * setup separate auth on multiple apps before mutualization. The app should
 * surface a UX dialog letting the user pick which one to keep.
 */
export function detectMigrationConflict(opts: DetectMigrationConflictOpts): boolean {
  return existsSync(opts.localVaultPath) && existsSync(opts.sharedVaultPath)
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
export function migrateLocalAuthToShared(opts: MigrateLocalAuthToSharedOpts): MigrationResult {
  const { localVaultPath, sharedVaultPath, appId } = opts
  const sharedExists = existsSync(sharedVaultPath)
  const localExists = existsSync(localVaultPath)

  if (!sharedExists && !localExists) {
    const result = buildResult('no-op-fresh-install', 'No vault to migrate (fresh install).', appId)
    logIfEnabled(opts, result)
    return result
  }

  if (sharedExists && !localExists) {
    const result = buildResult(
      'no-op-already-migrated',
      'Shared vault already exists; local already migrated by another app.',
      appId,
    )
    logIfEnabled(opts, result)
    return result
  }

  if (sharedExists && localExists) {
    const result = buildResult(
      'conflict-needs-resolution',
      'Both shared and local vaults exist; user must choose which to keep.',
      appId,
    )
    logIfEnabled(opts, result)
    return result
  }

  // Local exists, shared does not → perform migration
  let content: string
  try {
    content = readFileSync(localVaultPath, 'utf-8')
    JSON.parse(content) // sanity-check that it parses
  } catch (err) {
    const result = buildResult(
      'error',
      `Local vault unreadable: ${(err as Error).message}`,
      appId,
    )
    logIfEnabled(opts, result)
    return result
  }

  // Atomic write to shared location
  const sharedDir = path.dirname(sharedVaultPath)
  if (!existsSync(sharedDir)) {
    try {
      mkdirSync(sharedDir, { recursive: true })
    } catch (err) {
      const result = buildResult(
        'error',
        `Failed to create shared dir: ${(err as Error).message}`,
        appId,
      )
      logIfEnabled(opts, result)
      return result
    }
  }

  const tmp = `${sharedVaultPath}.tmp`
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
    renameSync(tmp, sharedVaultPath)
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
    const result = buildResult(
      'error',
      `Failed to write shared vault: ${(err as Error).message}`,
      appId,
    )
    logIfEnabled(opts, result)
    return result
  }

  // Shared write succeeded; rename local → .bak (best-effort but logged)
  const backupPath = `${localVaultPath}${BACKUP_SUFFIX}`
  try {
    renameSync(localVaultPath, backupPath)
  } catch (err) {
    // Shared was written but local backup failed — on next run, conflict
    // will be detected (both exist) and the user can resolve via UX.
    const result = buildResult(
      'error',
      `Shared vault written but local backup failed: ${(err as Error).message}`,
      appId,
    )
    logIfEnabled(opts, result)
    return result
  }

  const result = buildResult(
    'migrated',
    'Local vault successfully migrated to shared location and original backed up.',
    appId,
    { backupPath },
  )
  logIfEnabled(opts, result)
  return result
}
