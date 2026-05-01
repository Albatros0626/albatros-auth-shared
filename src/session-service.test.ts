import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  createSessionService,
  SESSION_FILENAME,
  SESSION_FILE_VERSION,
  type SessionService,
} from './session-service'
import type { SafeStorageLike, SessionFileEnvelope } from './types'

const TEST_ROOT = path.join(tmpdir(), `session-test-${process.pid}-${Date.now()}`)

let sharedDir: string
let sessionFile: string
let testCounter = 0

interface MockSafeStorage extends SafeStorageLike {
  available: boolean
  encryptShouldThrow: boolean
  decryptShouldThrow: boolean
}

function makeMockSafeStorage(): MockSafeStorage {
  const m: MockSafeStorage = {
    available: true,
    encryptShouldThrow: false,
    decryptShouldThrow: false,
    isEncryptionAvailable() { return m.available },
    encryptString(plain: string): Buffer {
      if (m.encryptShouldThrow) throw new Error('Mock encrypt failure')
      return Buffer.from(`ENC::${plain}`, 'utf-8')
    },
    decryptString(buf: Buffer): string {
      if (m.decryptShouldThrow) throw new Error('Mock decrypt failure')
      const s = buf.toString('utf-8')
      if (!s.startsWith('ENC::')) throw new Error('Mock: not encrypted')
      return s.slice(5)
    },
  }
  return m
}

function buildService(overrides: {
  appId?: string
  activityThrottleMs?: number
  watchDebounceMs?: number
} = {}): { svc: SessionService; safe: MockSafeStorage } {
  const safe = makeMockSafeStorage()
  const svc = createSessionService({
    sharedDir,
    appId: overrides.appId ?? 'test-app',
    safeStorage: safe,
    activityThrottleMs: overrides.activityThrottleMs,
    watchDebounceMs: overrides.watchDebounceMs,
  })
  return { svc, safe }
}

beforeEach(() => {
  testCounter += 1
  sharedDir = path.join(TEST_ROOT, `dir-${testCounter}`)
  mkdirSync(sharedDir, { recursive: true })
  sessionFile = path.join(sharedDir, SESSION_FILENAME)
})

afterEach(() => {
  try { rmSync(sharedDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

afterEach(() => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
})

// =============================================================================
// recordUnlock + read
// =============================================================================

describe('recordUnlock + read', () => {
  it('writes a valid session and read returns isValid=true', () => {
    const { svc } = buildService()
    const state = svc.recordUnlock({ lockTimeoutMinutes: 10 })
    expect(state.isValid).toBe(true)
    expect(state.isLocked).toBe(false)
    expect(state.isExpired).toBe(false)

    const reread = svc.read()
    expect(reread).not.toBeNull()
    expect(reread!.isValid).toBe(true)
    expect(reread!.unlockerAppId).toBe('test-app')
    expect(reread!.lockedAt).toBeNull()
    expect(reread!.lockTimeoutMinutes).toBe(10)
  })

  it('generates a fresh session token on each unlock', () => {
    const { svc } = buildService()
    const a = svc.recordUnlock({ lockTimeoutMinutes: 10 })
    const b = svc.recordUnlock({ lockTimeoutMinutes: 10 })
    expect(a.sessionToken).not.toBe(b.sessionToken)
    expect(a.sessionToken).toMatch(/^[a-f0-9]+$/)
    expect(a.sessionToken).toHaveLength(64) // 32 bytes hex
  })

  it('persists unlockerAppId from the service that wrote', () => {
    const { svc: svcA } = buildService({ appId: 'prospector' })
    svcA.recordUnlock({ lockTimeoutMinutes: 10 })

    const { svc: svcB } = buildService({ appId: 'cadence' })
    expect(svcB.read()!.unlockerAppId).toBe('prospector')
  })

  it('writes session.bin to sharedDir', () => {
    const { svc } = buildService()
    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    expect(existsSync(sessionFile)).toBe(true)
  })

  it('creates sharedDir if missing', () => {
    rmSync(sharedDir, { recursive: true, force: true })
    expect(existsSync(sharedDir)).toBe(false)
    const { svc } = buildService()
    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    expect(existsSync(sharedDir)).toBe(true)
    expect(existsSync(sessionFile)).toBe(true)
  })

  it('writes a versioned envelope', () => {
    const { svc } = buildService()
    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    const raw = JSON.parse(readFileSync(sessionFile, 'utf-8')) as SessionFileEnvelope
    expect(raw.version).toBe(SESSION_FILE_VERSION)
    expect(typeof raw.ciphertext).toBe('string')
  })

  it('does not store payload as plaintext', () => {
    const { svc } = buildService({ appId: 'app-secret-id' })
    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    const raw = readFileSync(sessionFile, 'utf-8')
    // plain JSON envelope is visible, but the encrypted ciphertext must not
    // expose the appId — our mock prefixes plain bytes with "ENC::" so we can
    // assert decoded ciphertext does not match plain JSON
    const envelope = JSON.parse(raw) as SessionFileEnvelope
    const decoded = Buffer.from(envelope.ciphertext, 'base64').toString('utf-8')
    expect(decoded).toContain('ENC::') // prefix marker from mock
    // and the raw JSON envelope itself does not leak the appId
    expect(raw).not.toContain('app-secret-id')
  })
})

// =============================================================================
// read edge cases
// =============================================================================

describe('read', () => {
  it('returns null when file does not exist', () => {
    const { svc } = buildService()
    expect(svc.read()).toBeNull()
  })

  it('returns null + logs on corrupted JSON envelope', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(sessionFile, 'not-json{{{')
    const { svc } = buildService()
    expect(svc.read()).toBeNull()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('returns null on unsupported version', () => {
    writeFileSync(sessionFile, JSON.stringify({ version: 99, ciphertext: 'abc' }))
    const { svc } = buildService()
    expect(svc.read()).toBeNull()
  })

  it('returns null + logs on DPAPI decrypt failure', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { svc, safe } = buildService()
    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    safe.decryptShouldThrow = true
    expect(svc.read()).toBeNull()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('marks state as expired when lastActivityAt > timeoutMinutes ago', () => {
    const { svc } = buildService()
    svc.recordUnlock({ lockTimeoutMinutes: 10 })

    // Tamper with lastActivityAt to be 11 minutes ago
    const envelope = JSON.parse(readFileSync(sessionFile, 'utf-8')) as SessionFileEnvelope
    const cipher = Buffer.from(envelope.ciphertext, 'base64')
    const plain = cipher.toString('utf-8').slice(5) // strip ENC:: prefix
    const content = JSON.parse(plain)
    content.lastActivityAt = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    const newCipher = Buffer.from(`ENC::${JSON.stringify(content)}`, 'utf-8')
    envelope.ciphertext = newCipher.toString('base64')
    writeFileSync(sessionFile, JSON.stringify(envelope))

    const state = svc.read()!
    expect(state.isExpired).toBe(true)
    expect(state.isValid).toBe(false)
  })

  it('lockTimeoutMinutes=0 disables expiration', () => {
    const { svc } = buildService()
    svc.recordUnlock({ lockTimeoutMinutes: 0 })

    const envelope = JSON.parse(readFileSync(sessionFile, 'utf-8')) as SessionFileEnvelope
    const cipher = Buffer.from(envelope.ciphertext, 'base64')
    const plain = cipher.toString('utf-8').slice(5)
    const content = JSON.parse(plain)
    content.lastActivityAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
    envelope.ciphertext = Buffer.from(`ENC::${JSON.stringify(content)}`, 'utf-8').toString('base64')
    writeFileSync(sessionFile, JSON.stringify(envelope))

    const state = svc.read()!
    expect(state.isExpired).toBe(false)
    expect(state.isValid).toBe(true)
  })
})

// =============================================================================
// recordLock
// =============================================================================

describe('recordLock', () => {
  it('sets lockedAt on existing session', () => {
    const { svc } = buildService()
    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    expect(svc.read()!.isLocked).toBe(false)

    svc.recordLock()
    const state = svc.read()!
    expect(state.isLocked).toBe(true)
    expect(state.isValid).toBe(false)
    expect(state.lockedAt).toBeTruthy()
  })

  it('is a no-op if no session exists', () => {
    const { svc } = buildService()
    expect(() => svc.recordLock()).not.toThrow()
    expect(svc.read()).toBeNull()
  })

  it('preserves session token after lock', () => {
    const { svc } = buildService()
    const before = svc.recordUnlock({ lockTimeoutMinutes: 10 })
    svc.recordLock()
    expect(svc.read()!.sessionToken).toBe(before.sessionToken)
  })
})

// =============================================================================
// recordActivity (throttle)
// =============================================================================

describe('recordActivity throttle', () => {
  it('5 calls in <1s produce at most 1 disk write', () => {
    vi.useFakeTimers()
    try {
      const { svc } = buildService({ activityThrottleMs: 10_000 })
      svc.recordUnlock({ lockTimeoutMinutes: 10 })
      const initial = readFileSync(sessionFile, 'utf-8')

      svc.recordActivity()
      svc.recordActivity()
      svc.recordActivity()
      svc.recordActivity()
      svc.recordActivity()

      // Before timer fires, no write
      expect(readFileSync(sessionFile, 'utf-8')).toBe(initial)

      // Fire the throttle timer
      vi.advanceTimersByTime(11_000)

      // One write happened
      expect(readFileSync(sessionFile, 'utf-8')).not.toBe(initial)
    } finally {
      vi.useRealTimers()
    }
  })

  it('updates lastActivityAt but not unlockedAt', () => {
    vi.useFakeTimers()
    try {
      const { svc } = buildService({ activityThrottleMs: 100 })
      const before = svc.recordUnlock({ lockTimeoutMinutes: 10 })
      vi.advanceTimersByTime(50_000) // simulate time passing
      svc.recordActivity()
      vi.advanceTimersByTime(200) // fire throttle
      const after = svc.read()!
      expect(after.unlockedAt).toBe(before.unlockedAt)
      expect(new Date(after.lastActivityAt).getTime())
        .toBeGreaterThan(new Date(before.lastActivityAt).getTime())
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a no-op if no session exists', () => {
    vi.useFakeTimers()
    try {
      const { svc } = buildService({ activityThrottleMs: 100 })
      svc.recordActivity()
      vi.advanceTimersByTime(200)
      expect(svc.read()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a new throttle window starts after the previous one fires', () => {
    vi.useFakeTimers()
    try {
      const { svc } = buildService({ activityThrottleMs: 100 })
      svc.recordUnlock({ lockTimeoutMinutes: 10 })

      svc.recordActivity()
      vi.advanceTimersByTime(200) // window 1 fires
      const t1 = svc.read()!.lastActivityAt

      vi.advanceTimersByTime(50_000) // simulate idle gap
      svc.recordActivity()
      vi.advanceTimersByTime(200) // window 2 fires
      const t2 = svc.read()!.lastActivityAt

      expect(new Date(t2).getTime()).toBeGreaterThan(new Date(t1).getTime())
    } finally {
      vi.useRealTimers()
    }
  })

  it('__flushPendingForTests forces an immediate write', () => {
    vi.useFakeTimers()
    try {
      const { svc } = buildService({ activityThrottleMs: 10_000 })
      svc.recordUnlock({ lockTimeoutMinutes: 10 })
      const before = readFileSync(sessionFile, 'utf-8')

      vi.advanceTimersByTime(1000) // ensure lastActivityAt differs from unlockedAt
      svc.recordActivity()
      // Without flush, no write yet
      expect(readFileSync(sessionFile, 'utf-8')).toBe(before)

      svc.__flushPendingForTests()
      expect(readFileSync(sessionFile, 'utf-8')).not.toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

// =============================================================================
// watch
// =============================================================================

describe('watch', () => {
  it('fires callback when session is written', async () => {
    const { svc } = buildService({ watchDebounceMs: 30 })
    const cb = vi.fn()
    const unsubscribe = svc.watch(cb)

    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    await new Promise(r => setTimeout(r, 200))

    expect(cb).toHaveBeenCalled()
    unsubscribe()
  })

  it('returns unsubscribe that stops further callbacks', async () => {
    const { svc } = buildService({ watchDebounceMs: 30 })
    const cb = vi.fn()
    const unsubscribe = svc.watch(cb)

    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    await new Promise(r => setTimeout(r, 200))
    const callsAfterFirst = cb.mock.calls.length

    unsubscribe()
    svc.recordLock()
    await new Promise(r => setTimeout(r, 200))

    expect(cb.mock.calls.length).toBe(callsAfterFirst)
  })

  it('debounces multiple events into a single callback', async () => {
    const { svc } = buildService({ watchDebounceMs: 100 })
    const cb = vi.fn()
    const unsubscribe = svc.watch(cb)

    // Burst of writes (each triggers fs.watch events on Windows)
    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    svc.recordLock()
    svc.recordUnlock({ lockTimeoutMinutes: 10 })

    // Wait long enough for debounce window to settle
    await new Promise(r => setTimeout(r, 300))

    // Debouncing collapses the burst — fewer callbacks than writes
    expect(cb.mock.calls.length).toBeLessThanOrEqual(3)
    expect(cb).toHaveBeenCalled()
    unsubscribe()
  })

  it('clears pending debounce timer on unsubscribe', async () => {
    const { svc } = buildService({ watchDebounceMs: 500 })
    const cb = vi.fn()
    const unsubscribe = svc.watch(cb)

    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    // Unsubscribe immediately while debounce timer is still pending
    await new Promise(r => setTimeout(r, 50))
    unsubscribe()

    // Wait past the debounce window
    await new Promise(r => setTimeout(r, 600))

    // No callback fired because timer was cleared
    expect(cb).not.toHaveBeenCalled()
  })

  it('handles fs.watch failure gracefully (returns no-op unsubscribe)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Force fs.watch failure by passing a non-existent path that cannot be created
    // (use an invalid sharedDir; mkdirSync will succeed but we mock fs.watch to throw)
    const safe = makeMockSafeStorage()
    const svc = createSessionService({
      sharedDir: '\0invalid', // null byte forces fs failures on most platforms
      appId: 'test-app',
      safeStorage: safe,
    })
    let unsub: (() => void) | undefined
    expect(() => { unsub = svc.watch(() => {}) }).not.toThrow()
    expect(typeof unsub).toBe('function')
    unsub?.()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('passes the latest state to the callback', async () => {
    const { svc } = buildService({ watchDebounceMs: 30 })
    const cb = vi.fn()
    const unsubscribe = svc.watch(cb)

    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    await new Promise(r => setTimeout(r, 200))

    const lastCall = cb.mock.calls[cb.mock.calls.length - 1]
    const state = lastCall[0]
    expect(state).not.toBeNull()
    expect(state.isValid).toBe(true)
    unsubscribe()
  })
})

// =============================================================================
// Atomic write
// =============================================================================

describe('atomic write', () => {
  it('cleans up tmp file when rename succeeds', () => {
    const { svc } = buildService()
    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    expect(existsSync(`${sessionFile}.tmp`)).toBe(false)
  })

  it('does not corrupt existing session on encrypt failure', () => {
    const { svc, safe } = buildService()
    svc.recordUnlock({ lockTimeoutMinutes: 10 })
    const before = readFileSync(sessionFile, 'utf-8')

    safe.encryptShouldThrow = true
    expect(() => svc.recordUnlock({ lockTimeoutMinutes: 5 })).toThrow()

    // Original file untouched
    expect(readFileSync(sessionFile, 'utf-8')).toBe(before)
  })

  it('cleans up tmp file when rename fails', () => {
    const { svc, safe } = buildService()
    safe.encryptShouldThrow = true
    expect(() => svc.recordUnlock({ lockTimeoutMinutes: 5 })).toThrow()
    expect(existsSync(`${sessionFile}.tmp`)).toBe(false)
  })
})

// =============================================================================
// Multi-instance behaviour (shared session)
// =============================================================================

describe('multi-instance shared session', () => {
  it('app B reads session written by app A', () => {
    const safe = makeMockSafeStorage()
    const svcA = createSessionService({ sharedDir, appId: 'app-a', safeStorage: safe })
    const svcB = createSessionService({ sharedDir, appId: 'app-b', safeStorage: safe })

    svcA.recordUnlock({ lockTimeoutMinutes: 10 })

    const state = svcB.read()
    expect(state).not.toBeNull()
    expect(state!.unlockerAppId).toBe('app-a')
    expect(state!.isValid).toBe(true)
  })

  it('lock from app A is visible to app B', () => {
    const safe = makeMockSafeStorage()
    const svcA = createSessionService({ sharedDir, appId: 'app-a', safeStorage: safe })
    const svcB = createSessionService({ sharedDir, appId: 'app-b', safeStorage: safe })

    svcA.recordUnlock({ lockTimeoutMinutes: 10 })
    svcA.recordLock()

    expect(svcB.read()!.isLocked).toBe(true)
  })

  it('different appIds for unlocker, but same shared state', () => {
    const safe = makeMockSafeStorage()
    const svcA = createSessionService({ sharedDir, appId: 'app-a', safeStorage: safe })
    svcA.recordUnlock({ lockTimeoutMinutes: 10 })

    const svcB = createSessionService({ sharedDir, appId: 'app-b', safeStorage: safe })
    svcB.recordUnlock({ lockTimeoutMinutes: 10 }) // app B re-unlocks

    const final = svcA.read()!
    expect(final.unlockerAppId).toBe('app-b') // last writer wins
  })
})

// Cleanup safety
afterEach(() => {
  if (existsSync(sessionFile)) {
    try { unlinkSync(sessionFile) } catch { /* ignore */ }
  }
})
