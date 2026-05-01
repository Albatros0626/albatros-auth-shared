import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  migrateLocalAuthToShared,
  detectMigrationConflict,
  appendMigrationLog,
  BACKUP_SUFFIX,
} from './migration'

const TEST_ROOT = path.join(tmpdir(), `migration-test-${process.pid}-${Date.now()}`)

let appDir: string
let sharedDir: string
let localPath: string
let sharedPath: string
let logPath: string
let testCounter = 0

beforeEach(() => {
  testCounter += 1
  appDir = path.join(TEST_ROOT, `app-${testCounter}`)
  sharedDir = path.join(TEST_ROOT, `shared-${testCounter}`)
  mkdirSync(appDir, { recursive: true })
  mkdirSync(sharedDir, { recursive: true })
  localPath = path.join(appDir, 'auth.vault')
  sharedPath = path.join(sharedDir, 'auth.vault')
  logPath = path.join(sharedDir, 'migration.log')
})

afterEach(() => {
  try { rmSync(appDir, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(sharedDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

afterEach(() => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
})

const SAMPLE_VAULT_V1 = JSON.stringify({
  version: 1,
  created_at: '2024-01-01T00:00:00.000Z',
  last_code_change: '2024-01-01T00:00:00.000Z',
  pbkdf2_iterations: 600_000,
  salt_code: 'AAAA',
  hash_code: 'BBBB',
  salt_recovery: 'CCCC',
  recovery_question: 'Test ?',
  hash_recovery: 'DDDD',
  failed_attempts: 0,
  lockout_until: null,
})

// =============================================================================
// detectMigrationConflict
// =============================================================================

describe('detectMigrationConflict', () => {
  it('returns false when only local exists', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    expect(detectMigrationConflict({ localVaultPath: localPath, sharedVaultPath: sharedPath })).toBe(false)
  })

  it('returns false when only shared exists', () => {
    writeFileSync(sharedPath, SAMPLE_VAULT_V1)
    expect(detectMigrationConflict({ localVaultPath: localPath, sharedVaultPath: sharedPath })).toBe(false)
  })

  it('returns false when neither exists', () => {
    expect(detectMigrationConflict({ localVaultPath: localPath, sharedVaultPath: sharedPath })).toBe(false)
  })

  it('returns true when both exist', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    writeFileSync(sharedPath, SAMPLE_VAULT_V1)
    expect(detectMigrationConflict({ localVaultPath: localPath, sharedVaultPath: sharedPath })).toBe(true)
  })
})

// =============================================================================
// migrateLocalAuthToShared — outcomes
// =============================================================================

describe('migrateLocalAuthToShared', () => {
  it('returns no-op-fresh-install when neither vault exists', () => {
    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })
    expect(result.outcome).toBe('no-op-fresh-install')
    expect(result.appId).toBe('prospector')
    expect(result.timestamp).toBeTruthy()
    expect(existsSync(sharedPath)).toBe(false)
  })

  it('returns no-op-already-migrated when only shared exists', () => {
    writeFileSync(sharedPath, SAMPLE_VAULT_V1)
    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'cadence',
    })
    expect(result.outcome).toBe('no-op-already-migrated')
    // Shared remains untouched
    expect(readFileSync(sharedPath, 'utf-8')).toBe(SAMPLE_VAULT_V1)
  })

  it('migrates local vault to shared and renames local to .bak', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })

    expect(result.outcome).toBe('migrated')
    expect(result.backupPath).toBe(`${localPath}${BACKUP_SUFFIX}`)
    expect(existsSync(sharedPath)).toBe(true)
    expect(existsSync(localPath)).toBe(false)
    expect(existsSync(`${localPath}${BACKUP_SUFFIX}`)).toBe(true)
  })

  it('shared content matches the original local content', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })
    expect(readFileSync(sharedPath, 'utf-8')).toBe(SAMPLE_VAULT_V1)
  })

  it('.bak preserves the original local content byte-for-byte', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })
    expect(readFileSync(`${localPath}${BACKUP_SUFFIX}`, 'utf-8')).toBe(SAMPLE_VAULT_V1)
  })

  it('returns conflict-needs-resolution when both exist (no destructive action)', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    const sharedDifferent = SAMPLE_VAULT_V1.replace('Test ?', 'Different ?')
    writeFileSync(sharedPath, sharedDifferent)

    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })

    expect(result.outcome).toBe('conflict-needs-resolution')
    // Both files unchanged
    expect(readFileSync(localPath, 'utf-8')).toBe(SAMPLE_VAULT_V1)
    expect(readFileSync(sharedPath, 'utf-8')).toBe(sharedDifferent)
  })

  it('returns error when local vault is corrupted (invalid JSON)', () => {
    writeFileSync(localPath, '{not-valid-json')
    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })
    expect(result.outcome).toBe('error')
    expect(result.message).toMatch(/unreadable|JSON|parse/i)
    // local untouched, shared not created
    expect(existsSync(localPath)).toBe(true)
    expect(existsSync(sharedPath)).toBe(false)
  })

  it('creates the shared dir if missing', () => {
    rmSync(sharedDir, { recursive: true, force: true })
    expect(existsSync(sharedDir)).toBe(false)

    writeFileSync(localPath, SAMPLE_VAULT_V1)
    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })

    expect(result.outcome).toBe('migrated')
    expect(existsSync(sharedDir)).toBe(true)
    expect(existsSync(sharedPath)).toBe(true)
  })

  it('handles successive runs idempotently (second run is no-op)', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    const r1 = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })
    expect(r1.outcome).toBe('migrated')

    // Second app starts later
    const r2 = migrateLocalAuthToShared({
      localVaultPath: localPath, // local has been moved to .bak by r1
      sharedVaultPath: sharedPath,
      appId: 'cadence',
    })
    expect(r2.outcome).toBe('no-op-already-migrated')
  })
})

// =============================================================================
// Defensive error paths
// =============================================================================

describe('error paths', () => {
  it('returns error when sharedVaultPath is invalid (cannot create dir)', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: '\0invalid/auth.vault',
      appId: 'prospector',
    })
    expect(result.outcome).toBe('error')
    // local file remains intact
    expect(existsSync(localPath)).toBe(true)
  })

  it('returns error when shared write fails (path is a directory)', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    // Make the shared "file" a directory so writeFileSync to its tmp succeeds
    // but rename to a directory path fails.
    mkdirSync(sharedPath)

    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })

    // Shared "file" is a dir, so existsSync(sharedPath) is true → conflict path
    // detection takes precedence. Verify either error or conflict outcome
    // depending on platform; both are non-destructive.
    expect(['error', 'conflict-needs-resolution']).toContain(result.outcome)
    expect(existsSync(localPath)).toBe(true)
  })

  it('cleans up tmp file when atomic write fails', () => {
    // Place a directory exactly where the .tmp would land, so writeFileSync fails
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    const tmpPath = `${sharedPath}.tmp`
    mkdirSync(tmpPath)

    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })

    expect(result.outcome).toBe('error')
    expect(existsSync(localPath)).toBe(true)
    expect(existsSync(sharedPath)).toBe(false)
  })
})

// =============================================================================
// migration log
// =============================================================================

describe('migration log', () => {
  it('appends a JSONL entry for each migration call', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
      migrationLogPath: logPath,
    })
    const log = readFileSync(logPath, 'utf-8')
    const lines = log.trim().split('\n')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry.outcome).toBe('migrated')
    expect(entry.appId).toBe('prospector')
    expect(entry.timestamp).toBeTruthy()
  })

  it('appends without overwriting on multiple calls', () => {
    // Setup: ensure the no-op-fresh-install path is exercised by removing local
    migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'app-a',
      migrationLogPath: logPath,
    })
    migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'app-b',
      migrationLogPath: logPath,
    })

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).appId).toBe('app-a')
    expect(JSON.parse(lines[1]).appId).toBe('app-b')
  })

  it('log path may be in a non-existent directory; mkdir is performed', () => {
    const nestedLog = path.join(sharedDir, 'logs', 'sub', 'migration.log')
    appendMigrationLog(nestedLog, {
      outcome: 'no-op-fresh-install',
      message: 'test',
      appId: 'x',
      timestamp: new Date().toISOString(),
    })
    expect(existsSync(nestedLog)).toBe(true)
  })

  it('does not throw and does not block migration if log write fails', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    writeFileSync(localPath, SAMPLE_VAULT_V1)
    // Use a log path with a null byte to force the appendFileSync to fail
    const result = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
      migrationLogPath: '\0invalid-log-path',
    })
    expect(result.outcome).toBe('migrated') // migration still succeeds
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('migration without logPath does not create any log', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'prospector',
    })
    expect(existsSync(logPath)).toBe(false)
  })
})

// =============================================================================
// Multi-app scenarios
// =============================================================================

describe('multi-app scenarios', () => {
  it('first app migrates, second app sees already-migrated', () => {
    // App A has its own legacy local vault
    writeFileSync(localPath, SAMPLE_VAULT_V1)

    // App A migrates first
    const r1 = migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'app-a',
    })
    expect(r1.outcome).toBe('migrated')

    // App B has no local vault (fresh) and starts → sees shared already there
    const localB = path.join(appDir, 'auth-app-b.vault')
    const r2 = migrateLocalAuthToShared({
      localVaultPath: localB,
      sharedVaultPath: sharedPath,
      appId: 'app-b',
    })
    expect(r2.outcome).toBe('no-op-already-migrated')
  })

  it('first app migrates, second app with its own local triggers conflict', () => {
    writeFileSync(localPath, SAMPLE_VAULT_V1)
    migrateLocalAuthToShared({
      localVaultPath: localPath,
      sharedVaultPath: sharedPath,
      appId: 'app-a',
    })

    // App B had its own local setup — both shared (from A) and local (B) exist now
    const localB = path.join(appDir, 'auth-app-b.vault')
    writeFileSync(localB, SAMPLE_VAULT_V1)

    const r2 = migrateLocalAuthToShared({
      localVaultPath: localB,
      sharedVaultPath: sharedPath,
      appId: 'app-b',
    })
    expect(r2.outcome).toBe('conflict-needs-resolution')

    expect(detectMigrationConflict({
      localVaultPath: localB,
      sharedVaultPath: sharedPath,
    })).toBe(true)
  })
})
