import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  createAuthService,
  validateCode,
  normalizeAnswer,
  LOCKOUT_THRESHOLD,
  VAULT_VERSION,
  DEFAULT_LOCK_TIMEOUT_MINUTES,
  type AuthService,
} from './auth-service'
import { VaultNotInitializedError, VaultVersionUnsupportedError } from './types'

const TEST_DIR = path.join(tmpdir(), `auth-shared-test-${process.pid}-${Date.now()}`)

let svc: AuthService
let vaultPath: string
let testCounter = 0

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  testCounter += 1
  vaultPath = path.join(TEST_DIR, `auth-${testCounter}.vault`)
  svc = createAuthService({ vaultPath })
})

afterEach(() => {
  if (existsSync(vaultPath)) {
    try { unlinkSync(vaultPath) } catch { /* ignore */ }
  }
})

afterEach(() => {
  // Final cleanup at the very end
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

// =============================================================================
// normalizeAnswer
// =============================================================================

describe('normalizeAnswer', () => {
  it('removes diacritics', () => {
    expect(normalizeAnswer('Éléphant')).toBe('elephant')
    expect(normalizeAnswer('café')).toBe('cafe')
    expect(normalizeAnswer('naïve')).toBe('naive')
  })

  it('lowercases', () => {
    expect(normalizeAnswer('PARIS')).toBe('paris')
  })

  it('trims spaces', () => {
    expect(normalizeAnswer('  paris  ')).toBe('paris')
  })

  it('collapses multiple spaces', () => {
    expect(normalizeAnswer('mon    chat')).toBe('mon chat')
  })

  it('combines all transformations', () => {
    expect(normalizeAnswer('  ÉLÉPHANT   Rose  ')).toBe('elephant rose')
  })
})

// =============================================================================
// validateCode
// =============================================================================

describe('validateCode', () => {
  it('accepts a code >= 6 characters non-trivial', () => {
    expect(validateCode('mypass1')).toEqual({ valid: true })
  })

  it('rejects < 6 characters', () => {
    expect(validateCode('ab12').valid).toBe(false)
  })

  it('rejects character repetition', () => {
    expect(validateCode('aaaaaa').valid).toBe(false)
    expect(validateCode('111111').valid).toBe(false)
  })

  it('rejects ascending numeric sequences', () => {
    expect(validateCode('123456').valid).toBe(false)
    expect(validateCode('345678').valid).toBe(false)
  })

  it('rejects descending numeric sequences', () => {
    expect(validateCode('654321').valid).toBe(false)
  })

  it('rejects keyboard patterns', () => {
    expect(validateCode('qwerty').valid).toBe(false)
    expect(validateCode('azerty').valid).toBe(false)
  })

  it('accepts non-consecutive digit codes', () => {
    expect(validateCode('135792').valid).toBe(true)
  })

  it('returns reason for short code', () => {
    const result = validateCode('abc')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/Minimum/)
  })

  it('returns reason for trivial code', () => {
    const result = validateCode('aaaaaa')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/trop simple/)
  })
})

// =============================================================================
// setup
// =============================================================================

describe('setup', () => {
  it('creates the vault on first setup', async () => {
    expect(svc.isSetupComplete()).toBe(false)
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    expect(svc.isSetupComplete()).toBe(true)
    expect(existsSync(vaultPath)).toBe(true)
  })

  it('throws if vault already exists', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    await expect(
      svc.setup({ code: 'mypass2', recoveryQuestion: 'Autre question xx', recoveryAnswer: 'autre' })
    ).rejects.toThrow('Setup already complete')
  })

  it('throws if code is invalid', async () => {
    await expect(
      svc.setup({ code: 'abc', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    ).rejects.toThrow()
    await expect(
      svc.setup({ code: '123456', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    ).rejects.toThrow()
  })

  it('throws if question too short', async () => {
    await expect(
      svc.setup({ code: 'mypass1', recoveryQuestion: 'Court', recoveryAnswer: 'ma-reponse' })
    ).rejects.toThrow(/Question/)
  })

  it('throws if answer too short after normalization', async () => {
    await expect(
      svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ab' })
    ).rejects.toThrow(/Réponse/)
    await expect(
      svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: '  ÀB  ' })
    ).rejects.toThrow(/Réponse/)
  })

  it('saves trimmed question', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: '  Ma question secrète ?  ', recoveryAnswer: 'ma-reponse' })
    expect(svc.getRecoveryQuestion()).toBe('Ma question secrète ?')
  })

  it('writes vault with version 2 and schemaCompat', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    const raw = JSON.parse(readFileSync(vaultPath, 'utf-8'))
    expect(raw.version).toBe(VAULT_VERSION)
    expect(raw.schemaCompat).toEqual([1, 2])
    expect(raw.lockTimeoutMinutes).toBe(DEFAULT_LOCK_TIMEOUT_MINUTES)
  })
})

// =============================================================================
// verifyCode / verifyCurrentCode
// =============================================================================

describe('verifyCode', () => {
  beforeEach(async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'éléphant ROSE' })
  })

  it('returns true for correct code', async () => {
    expect(await svc.verifyCode('mypass1')).toBe(true)
  })

  it('returns false for wrong code', async () => {
    expect(await svc.verifyCode('wrongpass')).toBe(false)
  })

  it('resets counter on success', async () => {
    await svc.verifyCode('wrong1')
    await svc.verifyCode('wrong2')
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD - 2)

    await svc.verifyCode('mypass1')
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD)
  })

  it('increments counter on each failure', async () => {
    await svc.verifyCode('wrong1')
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD - 1)
    await svc.verifyCode('wrong2')
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD - 2)
  })

  it('throws VaultNotInitializedError if vault missing', async () => {
    unlinkSync(vaultPath)
    await expect(svc.verifyCode('mypass1')).rejects.toBeInstanceOf(VaultNotInitializedError)
  })

  it('rejects codes < 6 chars without decrementing counter', async () => {
    expect(await svc.verifyCode('abc')).toBe(false)
    expect(await svc.verifyCode('12')).toBe(false)
    expect(await svc.verifyCode('a')).toBe(false)
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD)
  })

  it('handles empty string code without crashing', async () => {
    expect(await svc.verifyCode('')).toBe(false)
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD)
  })
})

describe('verifyCurrentCode (does not touch counter)', () => {
  beforeEach(async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
  })

  it('returns true for correct code', async () => {
    expect(await svc.verifyCurrentCode('mypass1')).toBe(true)
  })

  it('returns false for wrong code without decrementing counter', async () => {
    await svc.verifyCurrentCode('wrong1')
    await svc.verifyCurrentCode('wrong2')
    await svc.verifyCurrentCode('wrong3')
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD)
  })

  it('throws VaultNotInitializedError if vault missing', async () => {
    unlinkSync(vaultPath)
    await expect(svc.verifyCurrentCode('mypass1')).rejects.toBeInstanceOf(VaultNotInitializedError)
  })
})

// =============================================================================
// Anti-brute-force (delay + lockout)
// =============================================================================

describe('anti-brute-force', () => {
  beforeEach(async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
  })

  it('no delay before 3rd attempt', async () => {
    await svc.verifyCode('wrong1')
    await svc.verifyCode('wrong2')
    expect(svc.getLockoutStatus().required_delay_seconds).toBe(0)
  })

  it('2s delay at 3rd attempt (2^(3-2) = 2)', async () => {
    await svc.verifyCode('wrong1')
    await svc.verifyCode('wrong2')
    await svc.verifyCode('wrong3')
    expect(svc.getLockoutStatus().required_delay_seconds).toBe(2)
  })

  it('4s delay at 4th attempt', async () => {
    await svc.verifyCode('wrong1')
    await svc.verifyCode('wrong2')
    await svc.verifyCode('wrong3')
    await svc.verifyCode('wrong4')
    expect(svc.getLockoutStatus().required_delay_seconds).toBe(4)
  })

  it('lockout at 5th failure', { timeout: 60_000 }, async () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await svc.verifyCode(`wrong${i}`)
    }
    const status = svc.getLockoutStatus()
    expect(status.locked_until).not.toBeNull()
    expect(status.attempts_remaining).toBe(0)
  })

  it('during lockout, verifyCode rejects even correct code', { timeout: 60_000 }, async () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await svc.verifyCode(`wrong${i}`)
    }
    expect(await svc.verifyCode('mypass1')).toBe(false)
  })

  it('delay capped at 30s', () => {
    const vault = JSON.parse(readFileSync(vaultPath, 'utf-8'))
    vault.failed_attempts = 20
    vault.lockout_until = null
    writeFileSync(vaultPath, JSON.stringify(vault))
    expect(svc.getLockoutStatus().required_delay_seconds).toBe(30)
  })

  it('required_delay_seconds is 0 during active lockout', () => {
    const vault = JSON.parse(readFileSync(vaultPath, 'utf-8'))
    vault.failed_attempts = 5
    vault.lockout_until = new Date(Date.now() + 60_000).toISOString()
    writeFileSync(vaultPath, JSON.stringify(vault))
    expect(svc.getLockoutStatus().required_delay_seconds).toBe(0)
  })

  it('expired lockout timestamp returns locked_until: null', () => {
    const vault = JSON.parse(readFileSync(vaultPath, 'utf-8'))
    vault.failed_attempts = 5
    vault.lockout_until = new Date(Date.now() - 60_000).toISOString() // expired
    writeFileSync(vaultPath, JSON.stringify(vault))
    const status = svc.getLockoutStatus()
    expect(status.locked_until).toBeNull()
  })
})

// =============================================================================
// recover
// =============================================================================

describe('recover', () => {
  beforeEach(async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ÉLÉPHANT rose' })
  })

  it('accepts the correct answer (insensitive to accents/case)', async () => {
    await svc.recover('elephant ROSE', 'newpass1')
    expect(await svc.verifyCode('newpass1')).toBe(true)
  })

  it('rejects wrong answer and increments counter', async () => {
    await expect(svc.recover('mauvaise', 'newpass1')).rejects.toThrow('Réponse incorrecte')
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD - 1)
  })

  it('throws if new code invalid', async () => {
    await expect(svc.recover('elephant ROSE', 'abc')).rejects.toThrow()
  })

  it('resets counter and lockout on success', { timeout: 60_000 }, async () => {
    await svc.verifyCode('wrong1')
    await svc.verifyCode('wrong2')
    await svc.recover('elephant ROSE', 'newpass1')
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD)
    expect(svc.getLockoutStatus().locked_until).toBeNull()
  })

  it('updates last_code_change', async () => {
    const before = svc.getLastCodeChangeDate()
    await new Promise(r => setTimeout(r, 10))
    await svc.recover('elephant ROSE', 'newpass1')
    expect(svc.getLastCodeChangeDate()).not.toBe(before)
  })

  it('during lockout, rejects even correct answer', { timeout: 60_000 }, async () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await svc.verifyCode(`wrong${i}x`)
    }
    await expect(svc.recover('elephant ROSE', 'newpass1')).rejects.toThrow(/verrouillée/)
  })

  it('triggers lockout after LOCKOUT_THRESHOLD wrong recovery answers', { timeout: 60_000 }, async () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await expect(svc.recover(`mauvaise${i}`, 'newpass1')).rejects.toThrow()
    }
    expect(svc.getLockoutStatus().locked_until).not.toBeNull()
  })

  it('throws if vault missing', async () => {
    unlinkSync(vaultPath)
    await expect(svc.recover('elephant ROSE', 'newpass1')).rejects.toBeInstanceOf(VaultNotInitializedError)
  })
})

// =============================================================================
// testRecovery (read-only)
// =============================================================================

describe('testRecovery (does not consume attempt)', () => {
  beforeEach(async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ÉLÉPHANT rose' })
  })

  it('returns true for correct answer', async () => {
    expect(await svc.testRecovery('elephant ROSE')).toBe(true)
  })

  it('returns false for wrong answer without touching counter', { timeout: 60_000 }, async () => {
    for (let i = 0; i < 10; i++) {
      await svc.testRecovery(`mauvaise ${i}`)
    }
    expect(svc.getLockoutStatus().attempts_remaining).toBe(LOCKOUT_THRESHOLD)
    expect(svc.getLockoutStatus().locked_until).toBeNull()
  })

  it('throws if vault missing', async () => {
    unlinkSync(vaultPath)
    await expect(svc.testRecovery('elephant ROSE')).rejects.toBeInstanceOf(VaultNotInitializedError)
  })
})

// =============================================================================
// changeCode
// =============================================================================

describe('changeCode', () => {
  beforeEach(async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
  })

  it('changes code if old one is correct', async () => {
    await svc.changeCode('mypass1', 'newpass1')
    expect(await svc.verifyCode('newpass1')).toBe(true)
    expect(await svc.verifyCode('mypass1')).toBe(false)
  })

  it('rejects if old code is incorrect', async () => {
    await expect(svc.changeCode('wrong', 'newpass1')).rejects.toThrow('Ancien code incorrect')
  })

  it('rejects if new code is invalid', async () => {
    await expect(svc.changeCode('mypass1', 'abc')).rejects.toThrow()
  })

  it('updates last_code_change', async () => {
    const before = svc.getLastCodeChangeDate()
    await new Promise(r => setTimeout(r, 10))
    await svc.changeCode('mypass1', 'newpass1')
    expect(svc.getLastCodeChangeDate()).not.toBe(before)
  })

  it('throws if vault missing', async () => {
    unlinkSync(vaultPath)
    await expect(svc.changeCode('mypass1', 'newpass1')).rejects.toBeInstanceOf(VaultNotInitializedError)
  })
})

// =============================================================================
// changeRecovery
// =============================================================================

describe('changeRecovery', () => {
  beforeEach(async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
  })

  it('changes question and answer if code correct', async () => {
    await svc.changeRecovery('mypass1', 'Nouvelle question ?', 'nouvelle reponse')
    expect(svc.getRecoveryQuestion()).toBe('Nouvelle question ?')
    expect(await svc.testRecovery('nouvelle reponse')).toBe(true)
    expect(await svc.testRecovery('ma-reponse')).toBe(false)
  })

  it('rejects if code incorrect', async () => {
    await expect(svc.changeRecovery('wrong', 'Autre question ?', 'autre'))
      .rejects.toThrow('Code actuel incorrect')
  })

  it('rejects if question too short', async () => {
    await expect(svc.changeRecovery('mypass1', 'Court', 'ma-reponse')).rejects.toThrow(/Question/)
  })

  it('rejects if answer too short', async () => {
    await expect(svc.changeRecovery('mypass1', 'Nouvelle question ?', 'ab')).rejects.toThrow(/Réponse/)
  })

  it('throws if vault missing', async () => {
    unlinkSync(vaultPath)
    await expect(svc.changeRecovery('mypass1', 'Nouvelle question ?', 'reponse'))
      .rejects.toBeInstanceOf(VaultNotInitializedError)
  })
})

// =============================================================================
// getLockTimeoutMinutes / setLockTimeoutMinutes
// =============================================================================

describe('lockTimeoutMinutes', () => {
  it('returns DEFAULT_LOCK_TIMEOUT_MINUTES if vault missing', () => {
    expect(svc.getLockTimeoutMinutes()).toBe(DEFAULT_LOCK_TIMEOUT_MINUTES)
  })

  it('returns DEFAULT_LOCK_TIMEOUT_MINUTES after fresh setup', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    expect(svc.getLockTimeoutMinutes()).toBe(DEFAULT_LOCK_TIMEOUT_MINUTES)
  })

  it('updates the value via setLockTimeoutMinutes', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    svc.setLockTimeoutMinutes(30)
    expect(svc.getLockTimeoutMinutes()).toBe(30)
  })

  it('persists across service instances', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    svc.setLockTimeoutMinutes(15)
    const svc2 = createAuthService({ vaultPath })
    expect(svc2.getLockTimeoutMinutes()).toBe(15)
  })

  it('accepts 0 (disables auto-lock)', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    svc.setLockTimeoutMinutes(0)
    expect(svc.getLockTimeoutMinutes()).toBe(0)
  })

  it('rejects negative values', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    expect(() => svc.setLockTimeoutMinutes(-1)).toThrow()
  })

  it('rejects non-integer values', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    expect(() => svc.setLockTimeoutMinutes(1.5)).toThrow()
  })

  it('throws if vault missing on set', () => {
    expect(() => svc.setLockTimeoutMinutes(15)).toThrow(VaultNotInitializedError)
  })
})

// =============================================================================
// Vault version migration v1 -> v2
// =============================================================================

describe('vault migration v1 -> v2', () => {
  function buildV1Vault(): unknown {
    return {
      version: 1,
      created_at: '2024-01-01T00:00:00.000Z',
      last_code_change: '2024-01-01T00:00:00.000Z',
      pbkdf2_iterations: 600_000,
      salt_code: Buffer.alloc(16).toString('base64'),
      hash_code: Buffer.alloc(64).toString('base64'),
      salt_recovery: Buffer.alloc(16).toString('base64'),
      recovery_question: 'Legacy question ?',
      hash_recovery: Buffer.alloc(64).toString('base64'),
      failed_attempts: 0,
      lockout_until: null,
    }
  }

  it('migrates a v1 vault to v2 on first read', () => {
    writeFileSync(vaultPath, JSON.stringify(buildV1Vault()))
    expect(svc.getRecoveryQuestion()).toBe('Legacy question ?')
    const raw = JSON.parse(readFileSync(vaultPath, 'utf-8'))
    expect(raw.version).toBe(2)
    expect(raw.schemaCompat).toEqual([1, 2])
    expect(raw.lockTimeoutMinutes).toBe(DEFAULT_LOCK_TIMEOUT_MINUTES)
  })

  it('does not re-migrate an already-migrated vault (idempotent)', () => {
    writeFileSync(vaultPath, JSON.stringify(buildV1Vault()))
    svc.getRecoveryQuestion() // first migration
    const after1 = readFileSync(vaultPath, 'utf-8')
    svc.getRecoveryQuestion() // second read
    const after2 = readFileSync(vaultPath, 'utf-8')
    expect(after1).toBe(after2)
  })

  it('preserves legacy data on migration', () => {
    writeFileSync(vaultPath, JSON.stringify(buildV1Vault()))
    svc.getRecoveryQuestion()
    const raw = JSON.parse(readFileSync(vaultPath, 'utf-8'))
    expect(raw.recovery_question).toBe('Legacy question ?')
    expect(raw.created_at).toBe('2024-01-01T00:00:00.000Z')
    expect(raw.failed_attempts).toBe(0)
  })

  it('throws VaultVersionUnsupportedError for version > 2', () => {
    const futureVault = { ...buildV1Vault() as object, version: 99 }
    writeFileSync(vaultPath, JSON.stringify(futureVault))
    expect(() => svc.getRecoveryQuestion()).toThrow(VaultVersionUnsupportedError)
  })

  it('VaultVersionUnsupportedError carries vault version + supported list', () => {
    const futureVault = { ...buildV1Vault() as object, version: 99 }
    writeFileSync(vaultPath, JSON.stringify(futureVault))
    try {
      svc.getRecoveryQuestion()
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(VaultVersionUnsupportedError)
      const e = err as VaultVersionUnsupportedError
      expect(e.code).toBe('VAULT_VERSION_UNSUPPORTED')
      expect(e.vaultVersion).toBe(99)
      expect(e.supportedVersions).toEqual([1, 2])
    }
  })
})

// =============================================================================
// State without vault
// =============================================================================

describe('state without vault', () => {
  it('isSetupComplete returns false', () => {
    expect(svc.isSetupComplete()).toBe(false)
  })

  it('getLastCodeChangeDate returns null', () => {
    expect(svc.getLastCodeChangeDate()).toBeNull()
  })

  it('getLockoutStatus returns default state', () => {
    expect(svc.getLockoutStatus()).toEqual({
      locked_until: null,
      attempts_remaining: LOCKOUT_THRESHOLD,
      required_delay_seconds: 0,
    })
  })

  it('verifyCode throws VaultNotInitializedError', async () => {
    await expect(svc.verifyCode('any')).rejects.toBeInstanceOf(VaultNotInitializedError)
  })

  it('recover throws VaultNotInitializedError', async () => {
    await expect(svc.recover('any', 'newpass1')).rejects.toBeInstanceOf(VaultNotInitializedError)
  })

  it('getRecoveryQuestion throws VaultNotInitializedError', () => {
    expect(() => svc.getRecoveryQuestion()).toThrow(VaultNotInitializedError)
  })
})

// =============================================================================
// Multiple service instances on same vault
// =============================================================================

describe('multiple service instances', () => {
  it('two services on same vault see same state', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    const svc2 = createAuthService({ vaultPath })
    expect(svc2.isSetupComplete()).toBe(true)
    expect(await svc2.verifyCode('mypass1')).toBe(true)
  })

  it('write from one service is visible by another', async () => {
    await svc.setup({ code: 'mypass1', recoveryQuestion: 'Ma question secrète ?', recoveryAnswer: 'ma-reponse' })
    const svc2 = createAuthService({ vaultPath })
    await svc.changeCode('mypass1', 'newpass1')
    expect(await svc2.verifyCode('newpass1')).toBe(true)
    expect(await svc2.verifyCode('mypass1')).toBe(false)
  })
})
