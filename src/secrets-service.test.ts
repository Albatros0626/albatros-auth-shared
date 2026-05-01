import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  createSecretsService,
  anonymizeKeyForLog,
  SECRETS_VAULT_VERSION,
  type SecretsService,
} from './secrets-service'
import {
  KeyNotAllowedError,
  DPAPIUnavailableError,
  SecretsVaultVersionUnsupportedError,
  type SafeStorageLike,
} from './types'

const TEST_DIR = path.join(tmpdir(), `secrets-shared-test-${process.pid}-${Date.now()}`)
const ALLOWLIST = ['ai.apiKey', 'integrations.lusha.apiKey'] as const

let vaultPath: string
let testCounter = 0

interface MockSafeStorage extends SafeStorageLike {
  available: boolean
  encryptShouldThrow: boolean
  decryptShouldThrow: boolean
  encryptCalls: string[]
  decryptCalls: number
}

function makeMockSafeStorage(): MockSafeStorage {
  const m: MockSafeStorage = {
    available: true,
    encryptShouldThrow: false,
    decryptShouldThrow: false,
    encryptCalls: [],
    decryptCalls: 0,
    isEncryptionAvailable() {
      return m.available
    },
    encryptString(plain: string): Buffer {
      if (m.encryptShouldThrow) throw new Error('Mock encrypt failure')
      m.encryptCalls.push(plain)
      // Wrap with a marker prefix so we can distinguish encrypted from raw
      return Buffer.from(`ENC::${plain}`, 'utf-8')
    },
    decryptString(buf: Buffer): string {
      m.decryptCalls += 1
      if (m.decryptShouldThrow) throw new Error('Mock decrypt failure')
      const s = buf.toString('utf-8')
      if (!s.startsWith('ENC::')) {
        throw new Error('Mock: not an encrypted payload')
      }
      return s.slice(5)
    },
  }
  return m
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  testCounter += 1
  vaultPath = path.join(TEST_DIR, `secrets-${testCounter}.vault`)
})

afterEach(() => {
  if (existsSync(vaultPath)) {
    try { unlinkSync(vaultPath) } catch { /* ignore */ }
  }
  if (existsSync(`${vaultPath}.tmp`)) {
    try { unlinkSync(`${vaultPath}.tmp`) } catch { /* ignore */ }
  }
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

function buildService(overrides: Partial<MockSafeStorage> = {}): { svc: SecretsService; safe: MockSafeStorage } {
  const safe = makeMockSafeStorage()
  Object.assign(safe, overrides)
  const svc = createSecretsService({
    vaultPath,
    allowlist: ALLOWLIST,
    safeStorage: safe,
  })
  return { svc, safe }
}

// =============================================================================
// anonymizeKeyForLog
// =============================================================================

describe('anonymizeKeyForLog', () => {
  it('returns namespace.*** for dotted keys', () => {
    expect(anonymizeKeyForLog('ai.apiKey')).toBe('ai.***')
    expect(anonymizeKeyForLog('integrations.lusha.apiKey')).toBe('integrations.***')
  })

  it('returns *** for empty string', () => {
    expect(anonymizeKeyForLog('')).toBe('***')
  })

  it('returns *** for keys without separator', () => {
    expect(anonymizeKeyForLog('singleword')).toBe('***')
  })
})

// =============================================================================
// allowlist
// =============================================================================

describe('allowlist', () => {
  it('setSecret throws KeyNotAllowedError for unknown key', () => {
    const { svc } = buildService()
    expect(() => svc.setSecret('forbidden', 'val')).toThrow(KeyNotAllowedError)
  })

  it('getSecret throws KeyNotAllowedError for unknown key', () => {
    const { svc } = buildService()
    expect(() => svc.getSecret('forbidden')).toThrow(KeyNotAllowedError)
  })

  it('hasSecret throws KeyNotAllowedError for unknown key', () => {
    const { svc } = buildService()
    expect(() => svc.hasSecret('forbidden')).toThrow(KeyNotAllowedError)
  })

  it('deleteSecret throws KeyNotAllowedError for unknown key', () => {
    const { svc } = buildService()
    expect(() => svc.deleteSecret('forbidden')).toThrow(KeyNotAllowedError)
  })

  it('KeyNotAllowedError carries the offending key', () => {
    const { svc } = buildService()
    try {
      svc.setSecret('forbidden', 'val')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KeyNotAllowedError)
      expect((err as KeyNotAllowedError).key).toBe('forbidden')
      expect((err as KeyNotAllowedError).code).toBe('KEY_NOT_ALLOWED')
    }
  })

  it('accepts every key in the allowlist', () => {
    const { svc } = buildService()
    expect(() => svc.setSecret('ai.apiKey', 'sk-1')).not.toThrow()
    expect(() => svc.setSecret('integrations.lusha.apiKey', 'sk-2')).not.toThrow()
  })
})

// =============================================================================
// setSecret + getSecret round-trip
// =============================================================================

describe('setSecret + getSecret', () => {
  it('round-trip a value', () => {
    const { svc } = buildService()
    svc.setSecret('ai.apiKey', 'sk-12345')
    expect(svc.getSecret('ai.apiKey')).toBe('sk-12345')
  })

  it('returns null for absent key', () => {
    const { svc } = buildService()
    expect(svc.getSecret('ai.apiKey')).toBeNull()
  })

  it('overwrites existing secret', () => {
    const { svc } = buildService()
    svc.setSecret('ai.apiKey', 'old')
    svc.setSecret('ai.apiKey', 'new')
    expect(svc.getSecret('ai.apiKey')).toBe('new')
  })

  it('stores ciphertext (not plaintext) on disk', () => {
    const { svc } = buildService()
    svc.setSecret('ai.apiKey', 'sk-secret-value-12345')
    const onDisk = readFileSync(vaultPath, 'utf-8')
    expect(onDisk).not.toContain('sk-secret-value-12345')
  })

  it('encryptString is called with the plaintext', () => {
    const { svc, safe } = buildService()
    svc.setSecret('ai.apiKey', 'plain-value')
    expect(safe.encryptCalls).toEqual(['plain-value'])
  })

  it('decryptString is called when reading', () => {
    const { svc, safe } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    expect(safe.decryptCalls).toBe(0)
    svc.getSecret('ai.apiKey')
    expect(safe.decryptCalls).toBe(1)
  })

  it('returns null and logs on decrypt failure (does not crash)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { svc, safe } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    safe.decryptShouldThrow = true
    expect(svc.getSecret('ai.apiKey')).toBeNull()
    expect(errorSpy).toHaveBeenCalled()
    // Verify the log uses the anonymized form
    const firstCall = errorSpy.mock.calls[0]
    expect(String(firstCall[0])).toContain('ai.***')
    expect(String(firstCall[0])).not.toContain('apiKey')
    errorSpy.mockRestore()
  })
})

// =============================================================================
// hasSecret + deleteSecret
// =============================================================================

describe('hasSecret', () => {
  it('returns false when secret absent', () => {
    const { svc } = buildService()
    expect(svc.hasSecret('ai.apiKey')).toBe(false)
  })

  it('returns true after setSecret', () => {
    const { svc } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    expect(svc.hasSecret('ai.apiKey')).toBe(true)
  })

  it('returns false after deleteSecret', () => {
    const { svc } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    svc.deleteSecret('ai.apiKey')
    expect(svc.hasSecret('ai.apiKey')).toBe(false)
  })

  it('does not call decryptString (no plaintext leak risk)', () => {
    const { svc, safe } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    svc.hasSecret('ai.apiKey')
    expect(safe.decryptCalls).toBe(0)
  })
})

describe('deleteSecret', () => {
  it('removes an existing secret', () => {
    const { svc } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    svc.deleteSecret('ai.apiKey')
    expect(svc.getSecret('ai.apiKey')).toBeNull()
  })

  it('is a no-op for absent key', () => {
    const { svc } = buildService()
    expect(() => svc.deleteSecret('ai.apiKey')).not.toThrow()
  })

  it('preserves other secrets', () => {
    const { svc } = buildService()
    svc.setSecret('ai.apiKey', 'val1')
    svc.setSecret('integrations.lusha.apiKey', 'val2')
    svc.deleteSecret('ai.apiKey')
    expect(svc.getSecret('integrations.lusha.apiKey')).toBe('val2')
  })
})

// =============================================================================
// isAvailable / DPAPI unavailable
// =============================================================================

describe('DPAPI unavailability', () => {
  it('isAvailable returns true when safeStorage reports available', () => {
    const { svc } = buildService()
    expect(svc.isAvailable()).toBe(true)
  })

  it('isAvailable returns false when safeStorage reports unavailable', () => {
    const { svc } = buildService({ available: false })
    expect(svc.isAvailable()).toBe(false)
  })

  it('isAvailable returns false if isEncryptionAvailable throws', () => {
    const safe = makeMockSafeStorage()
    safe.isEncryptionAvailable = () => { throw new Error('OS keyring failure') }
    const svc = createSecretsService({ vaultPath, allowlist: ALLOWLIST, safeStorage: safe })
    expect(svc.isAvailable()).toBe(false)
  })

  it('setSecret throws DPAPIUnavailableError when DPAPI unavailable', () => {
    const { svc } = buildService({ available: false })
    expect(() => svc.setSecret('ai.apiKey', 'val')).toThrow(DPAPIUnavailableError)
  })

  it('getSecret returns null when DPAPI unavailable', () => {
    const { svc, safe } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    safe.available = false
    expect(svc.getSecret('ai.apiKey')).toBeNull()
  })

  it('hasSecret works without DPAPI (no decrypt needed)', () => {
    const { svc, safe } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    safe.available = false
    expect(svc.hasSecret('ai.apiKey')).toBe(true)
  })

  it('deleteSecret works without DPAPI (no decrypt needed)', () => {
    const { svc, safe } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    safe.available = false
    expect(() => svc.deleteSecret('ai.apiKey')).not.toThrow()
    safe.available = true
    expect(svc.hasSecret('ai.apiKey')).toBe(false)
  })
})

// =============================================================================
// Vault file format
// =============================================================================

describe('vault file format', () => {
  it('writes vault with version field', () => {
    const { svc } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    const raw = JSON.parse(readFileSync(vaultPath, 'utf-8'))
    expect(raw.version).toBe(SECRETS_VAULT_VERSION)
    expect(raw.secrets).toBeDefined()
  })

  it('returns empty vault when file does not exist', () => {
    const { svc } = buildService()
    expect(svc.hasSecret('ai.apiKey')).toBe(false)
    expect(existsSync(vaultPath)).toBe(false)
  })

  it('throws SecretsVaultVersionUnsupportedError on future version', () => {
    writeFileSync(vaultPath, JSON.stringify({ version: 999, secrets: {} }))
    const { svc } = buildService()
    expect(() => svc.getSecret('ai.apiKey')).toThrow(SecretsVaultVersionUnsupportedError)
  })

  it('SecretsVaultVersionUnsupportedError carries the version', () => {
    writeFileSync(vaultPath, JSON.stringify({ version: 42, secrets: {} }))
    const { svc } = buildService()
    try {
      svc.getSecret('ai.apiKey')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsVaultVersionUnsupportedError)
      expect((err as SecretsVaultVersionUnsupportedError).vaultVersion).toBe(42)
      expect((err as SecretsVaultVersionUnsupportedError).code).toBe('SECRETS_VAULT_VERSION_UNSUPPORTED')
    }
  })

  it('throws on corrupted vault (invalid JSON)', () => {
    writeFileSync(vaultPath, '{not-valid-json')
    const { svc } = buildService()
    expect(() => svc.getSecret('ai.apiKey')).toThrow()
  })
})

// =============================================================================
// Multiple instances on same vault
// =============================================================================

describe('multiple service instances', () => {
  it('two services on same vault see same state', () => {
    const { svc: svc1, safe } = buildService()
    svc1.setSecret('ai.apiKey', 'shared-val')
    const svc2 = createSecretsService({ vaultPath, allowlist: ALLOWLIST, safeStorage: safe })
    expect(svc2.getSecret('ai.apiKey')).toBe('shared-val')
  })

  it('write from one is visible by the other', () => {
    const { svc: svc1, safe } = buildService()
    const svc2 = createSecretsService({ vaultPath, allowlist: ALLOWLIST, safeStorage: safe })
    svc1.setSecret('ai.apiKey', 'val')
    expect(svc2.hasSecret('ai.apiKey')).toBe(true)
    svc2.deleteSecret('ai.apiKey')
    expect(svc1.hasSecret('ai.apiKey')).toBe(false)
  })

  it('different allowlists are enforced per service instance', () => {
    const safe = makeMockSafeStorage()
    const svcA = createSecretsService({
      vaultPath,
      allowlist: ['ai.apiKey'],
      safeStorage: safe,
    })
    const svcB = createSecretsService({
      vaultPath,
      allowlist: ['integrations.lusha.apiKey'],
      safeStorage: safe,
    })
    expect(() => svcA.setSecret('ai.apiKey', 'v')).not.toThrow()
    expect(() => svcA.setSecret('integrations.lusha.apiKey', 'v')).toThrow(KeyNotAllowedError)
    expect(() => svcB.setSecret('integrations.lusha.apiKey', 'v')).not.toThrow()
    expect(() => svcB.setSecret('ai.apiKey', 'v')).toThrow(KeyNotAllowedError)
  })
})

// =============================================================================
// Atomic write
// =============================================================================

describe('atomic write', () => {
  it('cleans up tmp file when rename succeeds', () => {
    const { svc } = buildService()
    svc.setSecret('ai.apiKey', 'val')
    expect(existsSync(`${vaultPath}.tmp`)).toBe(false)
  })

  it('does not corrupt existing vault on encrypt failure', () => {
    const { svc, safe } = buildService()
    svc.setSecret('ai.apiKey', 'good-value')
    safe.encryptShouldThrow = true
    expect(() => svc.setSecret('ai.apiKey', 'will-fail')).toThrow()
    safe.encryptShouldThrow = false
    expect(svc.getSecret('ai.apiKey')).toBe('good-value')
  })
})
