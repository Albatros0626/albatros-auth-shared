import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import { tmpdir } from 'os'
import {
  createBiometricService,
  BIOMETRIC_BLOB_VERSION,
  DEFAULT_BIOMETRIC_KEY_NAME,
  type BiometricService,
} from './biometric-service'
import { createAuthService, type AuthService } from './auth-service'
import type {
  BiometricAuthServiceLike,
  BiometricBlob,
  BiometricProviderLike,
  LockoutStatus,
} from './types'
import {
  BiometricCodeRejectedError,
  BiometricNonDeterministicError,
  BiometricUnavailableError,
  VaultNotInitializedError,
} from './types'

const TEST_DIR = path.join(tmpdir(), `biometric-shared-test-${process.pid}-${Date.now()}`)
const HWND = Buffer.from([1, 2, 3, 4])
const CODE = 'super-secret-42'

let blobPath: string
let testCounter = 0

// =============================================================================
// Fakes
// =============================================================================

interface FakeProvider extends BiometricProviderLike {
  available: boolean
  /** Key material, keyed by name. Absent ⇒ the key does not exist. */
  keys: Map<string, string>
  /** Makes sign() return a fresh value each time (non-deterministic TPM). */
  nondeterministic: boolean
  /** When set, sign() rejects with this error. */
  signError: (Error & { reason?: string }) | null
  createCalls: number
  signCalls: number
  deleteCalls: number
  /** Runs before each sign resolves — used to simulate concurrent changes. */
  onSign: (() => void) | null
}

function makeProvider(): FakeProvider {
  let nonce = 0
  const p: FakeProvider = {
    available: true,
    keys: new Map(),
    nondeterministic: false,
    signError: null,
    createCalls: 0,
    signCalls: 0,
    deleteCalls: 0,
    onSign: null,

    async isAvailable(): Promise<boolean> {
      return p.available
    },

    async createKey(keyName: string): Promise<void> {
      p.createCalls += 1
      // Mirrors ReplaceExisting: a fresh key pair each time.
      p.keys.set(keyName, `key-material-${p.createCalls}`)
    },

    async sign(keyName: string, challenge: Buffer): Promise<Buffer> {
      p.signCalls += 1
      p.onSign?.()
      if (p.signError) throw p.signError
      const material = p.keys.get(keyName)
      if (!material) {
        const err = Object.assign(new Error('key not found'), { reason: 'not-found' })
        throw err
      }
      const salt = p.nondeterministic ? `-${++nonce}` : ''
      // Deterministic by construction, like a real Hello RSA PKCS#1 v1.5 sign.
      return createHash('sha256').update(`${material}${salt}`).update(challenge).digest()
    },

    async deleteKey(keyName: string): Promise<void> {
      p.deleteCalls += 1
      p.keys.delete(keyName)
    },
  }
  return p
}

interface FakeAuth extends BiometricAuthServiceLike {
  currentCode: string
  lastCodeChange: string | null
  lockedUntil: string | null
  verifyCodeCalls: string[]
  failedAttempts: number
}

function makeAuth(): FakeAuth {
  const a: FakeAuth = {
    currentCode: CODE,
    lastCodeChange: '2026-08-17T08:00:00.000Z',
    lockedUntil: null,
    verifyCodeCalls: [],
    failedAttempts: 0,

    async verifyCode(code: string): Promise<boolean> {
      a.verifyCodeCalls.push(code)
      if (a.lockedUntil) return false
      const ok = code === a.currentCode
      if (!ok) a.failedAttempts += 1
      return ok
    },

    async verifyCurrentCode(code: string): Promise<boolean> {
      return code === a.currentCode
    },

    getLastCodeChangeDate(): string | null {
      return a.lastCodeChange
    },

    getLockoutStatus(): LockoutStatus {
      return {
        locked_until: a.lockedUntil,
        attempts_remaining: 5 - a.failedAttempts,
        required_delay_seconds: 0,
      }
    },
  }
  return a
}

function readBlobFile(): BiometricBlob {
  return JSON.parse(readFileSync(blobPath, 'utf-8')) as BiometricBlob
}

// =============================================================================

let provider: FakeProvider
let auth: FakeAuth
let svc: BiometricService
let consoleSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  testCounter += 1
  blobPath = path.join(TEST_DIR, `biometric-${testCounter}.bin`)
  provider = makeProvider()
  auth = makeAuth()
  svc = createBiometricService({ blobPath, provider, authService: auth })
  // The service logs every blob destruction; keep the test output readable.
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleSpy.mockRestore()
  if (existsSync(blobPath)) {
    try { unlinkSync(blobPath) } catch { /* ignore */ }
  }
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

// =============================================================================
// Nominal flow
// =============================================================================

describe('enroll + unlock', () => {
  it('enrols and then unlocks', async () => {
    expect(svc.isEnrolled()).toBe(false)

    await svc.enroll(CODE, HWND)
    expect(svc.isEnrolled()).toBe(true)
    expect(existsSync(blobPath)).toBe(true)

    const result = await svc.unlock(HWND)
    expect(result.ok).toBe(true)
    expect(result.failure).toBeUndefined()
    expect(auth.verifyCodeCalls).toEqual([CODE])
  })

  it('goes through verifyCode — never bypasses it', async () => {
    await svc.enroll(CODE, HWND)
    expect(auth.verifyCodeCalls).toHaveLength(0)

    await svc.unlock(HWND)
    expect(auth.verifyCodeCalls).toEqual([CODE])
  })

  it('never stores the code in clear', async () => {
    await svc.enroll(CODE, HWND)
    expect(readFileSync(blobPath, 'utf-8')).not.toContain(CODE)
  })

  it('writes a blob bound to the current code change date', async () => {
    await svc.enroll(CODE, HWND)
    const blob = readBlobFile()
    expect(blob.version).toBe(BIOMETRIC_BLOB_VERSION)
    expect(blob.keyName).toBe(DEFAULT_BIOMETRIC_KEY_NAME)
    expect(blob.boundTo).toBe(auth.lastCodeChange)
  })

  it('honours a custom key name', async () => {
    const custom = createBiometricService({
      blobPath, provider, authService: auth, keyName: 'AlbatrosProspector',
    })
    await custom.enroll(CODE, HWND)
    expect(provider.keys.has('AlbatrosProspector')).toBe(true)
    expect(readBlobFile().keyName).toBe('AlbatrosProspector')
  })

  it('re-enrolling replaces the key and keeps working', async () => {
    await svc.enroll(CODE, HWND)
    await svc.enroll(CODE, HWND)
    expect(provider.createCalls).toBe(2)
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: true })
  })
})

// =============================================================================
// Enrolment refusals
// =============================================================================

describe('enroll refusals', () => {
  it('rejects a wrong code without touching the lockout counter', async () => {
    await expect(svc.enroll('wrong-code', HWND)).rejects.toBeInstanceOf(BiometricCodeRejectedError)
    expect(auth.failedAttempts).toBe(0)
    expect(auth.verifyCodeCalls).toHaveLength(0)
    expect(existsSync(blobPath)).toBe(false)
    expect(provider.createCalls).toBe(0)
  })

  it('throws when the platform is unavailable', async () => {
    provider.available = false
    await expect(svc.enroll(CODE, HWND)).rejects.toBeInstanceOf(BiometricUnavailableError)
    expect(existsSync(blobPath)).toBe(false)
  })

  it('throws when the vault is not initialised', async () => {
    auth.lastCodeChange = null
    await expect(svc.enroll(CODE, HWND)).rejects.toBeInstanceOf(VaultNotInitializedError)
    expect(provider.createCalls).toBe(0)
  })

  it('is all-or-nothing when signing fails: key removed, no blob', async () => {
    provider.signError = Object.assign(new Error('user cancelled'), { reason: 'cancelled' })
    await expect(svc.enroll(CODE, HWND)).rejects.toThrow('user cancelled')
    expect(existsSync(blobPath)).toBe(false)
    expect(provider.deleteCalls).toBe(1)
    expect(provider.keys.size).toBe(0)
  })

  it('refuses a platform whose signatures are not deterministic', async () => {
    provider.nondeterministic = true
    await expect(svc.enroll(CODE, HWND)).rejects.toBeInstanceOf(BiometricNonDeterministicError)
    expect(existsSync(blobPath)).toBe(false)
    expect(provider.deleteCalls).toBe(1)
    expect(provider.keys.size).toBe(0)
  })

  it('refuses to enrol while the vault is locked out', async () => {
    // Without this guard, enroll() would be a lockout-free brute-force
    // oracle: verifyCurrentCode neither counts attempts nor checks lockout.
    auth.lockedUntil = '2099-01-01T00:00:00.000Z'

    await expect(svc.enroll(CODE, HWND)).rejects.toThrow('Application verrouillée')
    expect(provider.createCalls).toBe(0)
    expect(existsSync(blobPath)).toBe(false)
  })

  it('keeps the previous enrolment when re-enrolment is cancelled at key creation', async () => {
    await svc.enroll(CODE, HWND)

    const originalCreate = provider.createKey.bind(provider)
    provider.createKey = async () => {
      throw Object.assign(new Error('user cancelled'), { reason: 'cancelled' })
    }
    await expect(svc.enroll(CODE, HWND)).rejects.toThrow('user cancelled')
    provider.createKey = originalCreate

    // The old key pair was never replaced, so the old enrolment still works.
    expect(svc.isEnrolled()).toBe(true)
    expect(provider.deleteCalls).toBe(0)
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: true })
  })

  it('refuses to seal a code superseded during verification', async () => {
    const originalVerify = auth.verifyCurrentCode.bind(auth)
    auth.verifyCurrentCode = async (code: string) => {
      const ok = await originalVerify(code)
      // Another app completes changeCode() while PBKDF2 runs (~300ms).
      auth.currentCode = 'changed-mid-verify'
      auth.lastCodeChange = '2026-08-18T11:00:00.000Z'
      return ok
    }

    await expect(svc.enroll(CODE, HWND)).rejects.toBeInstanceOf(BiometricCodeRejectedError)
    expect(provider.createCalls).toBe(0)
    expect(existsSync(blobPath)).toBe(false)
  })

  it('does not write a blob when the code changes during the Hello prompts', async () => {
    provider.onSign = () => {
      // changeCode() from another app while the prompt is on screen.
      auth.currentCode = 'changed-mid-prompt'
      auth.lastCodeChange = '2026-08-18T12:00:00.000Z'
    }

    await expect(svc.enroll(CODE, HWND)).rejects.toBeInstanceOf(BiometricCodeRejectedError)
    expect(existsSync(blobPath)).toBe(false)
    // All-or-nothing: the freshly created key was cleaned up too.
    expect(provider.deleteCalls).toBe(1)
    expect(provider.keys.size).toBe(0)
  })
})

// =============================================================================
// Invalidation
// =============================================================================

describe('invalidation', () => {
  it('discards the blob when the code changed — before prompting', async () => {
    await svc.enroll(CODE, HWND)
    const signsAfterEnrol = provider.signCalls

    auth.currentCode = 'a-brand-new-code'
    auth.lastCodeChange = '2026-08-18T09:00:00.000Z'

    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'stale' })
    expect(existsSync(blobPath)).toBe(false)
    // No prompt, no attempt burned.
    expect(provider.signCalls).toBe(signsAfterEnrol)
    expect(auth.verifyCodeCalls).toHaveLength(0)
    expect(auth.failedAttempts).toBe(0)
  })

  it('discards the blob when the Hello key no longer exists, without calling verifyCode', async () => {
    await svc.enroll(CODE, HWND)
    // NGC/TPM reset: the key pair is permanently gone, not temporarily busy.
    provider.keys.clear()

    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'key-mismatch', reason: 'not-found' })
    expect(existsSync(blobPath)).toBe(false)
    // Self-healing promise: the button (gated on isEnrolled) vanishes.
    expect(svc.isEnrolled()).toBe(false)
    expect(auth.verifyCodeCalls).toHaveLength(0)
    expect(auth.failedAttempts).toBe(0)
  })

  it('discards the blob when the key material changed, without calling verifyCode', async () => {
    await svc.enroll(CODE, HWND)
    // A different key pair signs differently → GCM tag check fails.
    await provider.createKey(DEFAULT_BIOMETRIC_KEY_NAME, HWND)

    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'key-mismatch' })
    expect(existsSync(blobPath)).toBe(false)
    expect(auth.verifyCodeCalls).toHaveLength(0)
    expect(auth.failedAttempts).toBe(0)
  })

  it('keeps the enrolment valid when only the recovery question changed', async () => {
    await svc.enroll(CODE, HWND)
    // changeRecovery() does not move last_code_change.
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: true })
    expect(svc.isEnrolled()).toBe(true)
  })

  it('disable() removes both the blob and the Hello key', async () => {
    await svc.enroll(CODE, HWND)
    await svc.disable()

    expect(svc.isEnrolled()).toBe(false)
    expect(existsSync(blobPath)).toBe(false)
    expect(provider.keys.size).toBe(0)
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: false, failure: 'not-enrolled' })
  })
})

// =============================================================================
// Tamper resistance (AAD)
// =============================================================================

describe('blob integrity', () => {
  async function tamper(mutate: (b: BiometricBlob) => void): Promise<void> {
    await svc.enroll(CODE, HWND)
    const blob = readBlobFile()
    mutate(blob)
    writeFileSync(blobPath, JSON.stringify(blob, null, 2))
  }

  it('rejects a forged boundTo', async () => {
    // Without AAD this would let a stale blob masquerade as fresh.
    await tamper((b) => { b.boundTo = '2099-01-01T00:00:00.000Z' })
    auth.lastCodeChange = '2099-01-01T00:00:00.000Z'

    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'key-mismatch' })
    expect(auth.verifyCodeCalls).toHaveLength(0)
  })

  it('rejects a swapped challenge', async () => {
    await tamper((b) => { b.challenge = Buffer.alloc(32, 0xaa).toString('base64') })
    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'key-mismatch' })
    expect(auth.verifyCodeCalls).toHaveLength(0)
  })

  it('rejects a tampered createdAt', async () => {
    await tamper((b) => { b.createdAt = '1999-01-01T00:00:00.000Z' })
    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'key-mismatch' })
  })

  it('rejects a mutated ciphertext', async () => {
    await tamper((b) => {
      const buf = Buffer.from(b.ciphertext, 'base64')
      buf[0] ^= 0xff
      b.ciphertext = buf.toString('base64')
    })
    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'key-mismatch' })
  })
})

// =============================================================================
// Blob format policy
// =============================================================================

describe('blob format', () => {
  it('discards an unparseable blob', async () => {
    writeFileSync(blobPath, 'not json at all')
    expect(svc.isEnrolled()).toBe(false)
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: false, failure: 'not-enrolled' })
    expect(existsSync(blobPath)).toBe(false)
  })

  it('discards a blob missing required fields', async () => {
    writeFileSync(blobPath, JSON.stringify({ version: BIOMETRIC_BLOB_VERSION, keyName: 'x' }))
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: false, failure: 'not-enrolled' })
    expect(existsSync(blobPath)).toBe(false)
  })

  it('leaves a blob written by a newer app untouched', async () => {
    // An older app must never revoke an enrolment made by a newer one.
    const future = JSON.stringify({ version: BIOMETRIC_BLOB_VERSION + 1, opaque: true })
    writeFileSync(blobPath, future)

    expect(svc.isEnrolled()).toBe(false)
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: false, failure: 'not-enrolled' })
    expect(existsSync(blobPath)).toBe(true)
    expect(readFileSync(blobPath, 'utf-8')).toBe(future)
  })

  it('discards a blob with an unsupported OLD version', async () => {
    // version 0 is junk, not "written by a newer app" — it must go through
    // the corrupt path, not be preserved forever under a misleading log.
    writeFileSync(blobPath, JSON.stringify({ version: 0, keyName: 'x' }))

    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: false, failure: 'not-enrolled' })
    expect(existsSync(blobPath)).toBe(false)
  })
})

// =============================================================================
// Divergent keyName configurations sharing one blob
// =============================================================================

describe('cross-keyName', () => {
  it('unlocks a blob enrolled under a different configured keyName', async () => {
    const prospector = createBiometricService({
      blobPath, provider, authService: auth, keyName: 'AlbatrosProspector',
    })
    await prospector.enroll(CODE, HWND)

    // svc uses the default keyName. It must sign with the key recorded in
    // the blob — signing with its own would fail GCM and destroy
    // Prospector's valid enrolment.
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: true })
    expect(svc.isEnrolled()).toBe(true)
  })

  it('disable() removes the key recorded in the blob, not the configured one', async () => {
    const prospector = createBiometricService({
      blobPath, provider, authService: auth, keyName: 'AlbatrosProspector',
    })
    await prospector.enroll(CODE, HWND)

    await svc.disable() // configured with the default keyName
    expect(existsSync(blobPath)).toBe(false)
    // No orphan credential left on the profile.
    expect(provider.keys.has('AlbatrosProspector')).toBe(false)
  })
})

// =============================================================================
// Lockout interplay
// =============================================================================

describe('lockout', () => {
  it('short-circuits before prompting when the vault is locked out', async () => {
    await svc.enroll(CODE, HWND)
    const signsAfterEnrol = provider.signCalls
    auth.lockedUntil = '2099-01-01T00:00:00.000Z'

    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'code-refused' })
    expect(result.lockoutStatus?.locked_until).toBe('2099-01-01T00:00:00.000Z')
    // The user is not asked for a finger just to be refused.
    expect(provider.signCalls).toBe(signsAfterEnrol)
    expect(auth.verifyCodeCalls).toHaveLength(0)
  })

  it('keeps the enrolment when Hello is refused, and reports the reason', async () => {
    await svc.enroll(CODE, HWND)
    provider.signError = Object.assign(new Error('locked'), { reason: 'device-locked' })

    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'rejected', reason: 'device-locked' })
    // Transient: the user must still be able to try again.
    expect(svc.isEnrolled()).toBe(true)
    expect(auth.failedAttempts).toBe(0)
  })

  it('reports unknown for a provider error carrying no reason', async () => {
    await svc.enroll(CODE, HWND)
    provider.signError = new Error('something odd')
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ failure: 'rejected', reason: 'unknown' })
  })
})

// =============================================================================
// TOCTOU + concurrency
// =============================================================================

describe('races', () => {
  it('does not spend an attempt when the code changes during the prompt', async () => {
    await svc.enroll(CODE, HWND)

    // Another Albatros app runs changeCode() while Hello is on screen.
    provider.onSign = () => {
      auth.currentCode = 'changed-mid-prompt'
      auth.lastCodeChange = '2026-08-18T10:00:00.000Z'
      provider.onSign = null
    }

    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'stale' })
    expect(auth.verifyCodeCalls).toHaveLength(0)
    expect(auth.failedAttempts).toBe(0)
    expect(existsSync(blobPath)).toBe(false)
  })

  it('serialises concurrent unlocks into a single prompt', async () => {
    await svc.enroll(CODE, HWND)
    const signsAfterEnrol = provider.signCalls

    const [a, b] = await Promise.all([svc.unlock(HWND), svc.unlock(HWND)])

    expect(a).toMatchObject({ ok: true })
    expect(b).toMatchObject({ ok: true })
    expect(provider.signCalls).toBe(signsAfterEnrol + 1)
    expect(auth.verifyCodeCalls).toEqual([CODE])
  })

  it('allows a fresh unlock once the previous one settled', async () => {
    await svc.enroll(CODE, HWND)
    await svc.unlock(HWND)
    await svc.unlock(HWND)
    expect(auth.verifyCodeCalls).toEqual([CODE, CODE])
  })
})

// =============================================================================
// No provider
// =============================================================================

describe('without a provider', () => {
  let noProv: BiometricService

  beforeEach(() => {
    noProv = createBiometricService({ blobPath, authService: auth })
  })

  it('reports unsupported and not enrolled', async () => {
    await expect(noProv.isSupported()).resolves.toBe(false)
    expect(noProv.isEnrolled()).toBe(false)
  })

  it('reports not enrolled even when a blob exists on disk', async () => {
    await svc.enroll(CODE, HWND)
    expect(existsSync(blobPath)).toBe(true)

    expect(noProv.isEnrolled()).toBe(false)
    await expect(noProv.unlock(HWND)).resolves.toMatchObject({
      ok: false, failure: 'not-enrolled',
    })
    // ...and does not destroy the other app's enrolment.
    expect(existsSync(blobPath)).toBe(true)
  })

  it('refuses to enrol', async () => {
    await expect(noProv.enroll(CODE, HWND)).rejects.toBeInstanceOf(BiometricUnavailableError)
  })

  it('treats a throwing isAvailable as unsupported', async () => {
    provider.isAvailable = async () => { throw new Error('addon exploded') }
    await expect(svc.isSupported()).resolves.toBe(false)
    await expect(svc.enroll(CODE, HWND)).rejects.toBeInstanceOf(BiometricUnavailableError)
  })
})

// =============================================================================
// Integration against the real AuthService
// =============================================================================

describe('with the real AuthService', () => {
  let authSvc: AuthService
  let vaultPath: string

  beforeEach(async () => {
    vaultPath = path.join(TEST_DIR, `auth-${testCounter}.vault`)
    authSvc = createAuthService({ vaultPath })
    await authSvc.setup({
      code: CODE,
      recoveryQuestion: 'Nom de votre premier animal ?',
      recoveryAnswer: 'Pistache',
    })
    svc = createBiometricService({ blobPath, provider, authService: authSvc })
  })

  afterEach(() => {
    if (existsSync(vaultPath)) {
      try { unlinkSync(vaultPath) } catch { /* ignore */ }
    }
  })

  it('enrols and unlocks against the real vault', async () => {
    await svc.enroll(CODE, HWND)
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: true })
  })

  it('is invalidated by changeCode, leaving the lockout counter intact', async () => {
    await svc.enroll(CODE, HWND)
    await authSvc.changeCode(CODE, 'another-good-code')

    const result = await svc.unlock(HWND)
    expect(result).toMatchObject({ ok: false, failure: 'stale' })
    expect(existsSync(blobPath)).toBe(false)
    expect(authSvc.getLockoutStatus().attempts_remaining).toBe(5)
  })

  it('survives changeRecovery', async () => {
    await svc.enroll(CODE, HWND)
    await authSvc.changeRecovery(CODE, 'Ville de naissance ?', 'Bordeaux')
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: true })
  })

  it('is invalidated by a recovery-driven code reset', async () => {
    await svc.enroll(CODE, HWND)
    await authSvc.recover('Pistache', 'recovered-code-9')
    await expect(svc.unlock(HWND)).resolves.toMatchObject({ ok: false, failure: 'stale' })
  })
})
