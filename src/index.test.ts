import { describe, it, expect } from 'vitest'
import {
  VERSION,
  createAuthService,
  createBiometricService,
  validateCode,
  normalizeAnswer,
  RECOVERY_QUESTIONS,
  BIOMETRIC_BLOB_VERSION,
  DEFAULT_BIOMETRIC_KEY_NAME,
  VaultVersionUnsupportedError,
  VaultNotInitializedError,
  BiometricUnavailableError,
  BiometricCodeRejectedError,
  BiometricNonDeterministicError,
  createRequestLockHandler,
} from './index'
import * as browserEntry from './browser'

describe('package public API', () => {
  it('exports VERSION constant', () => {
    expect(VERSION).toBe('4.0.0')
  })

  it('exports the request-lock handler factory', () => {
    expect(typeof createRequestLockHandler).toBe('function')
  })

  it('exports auth-service factory', () => {
    expect(typeof createAuthService).toBe('function')
  })

  it('exports validateCode and normalizeAnswer', () => {
    expect(typeof validateCode).toBe('function')
    expect(typeof normalizeAnswer).toBe('function')
  })

  it('exports recovery questions constants', () => {
    expect(Array.isArray(RECOVERY_QUESTIONS)).toBe(true)
    expect(RECOVERY_QUESTIONS.length).toBeGreaterThan(0)
  })

  it('exports error classes', () => {
    expect(typeof VaultVersionUnsupportedError).toBe('function')
    expect(typeof VaultNotInitializedError).toBe('function')
  })

  it('exports biometric-service factory and constants', () => {
    expect(typeof createBiometricService).toBe('function')
    expect(BIOMETRIC_BLOB_VERSION).toBe(1)
    expect(typeof DEFAULT_BIOMETRIC_KEY_NAME).toBe('string')
  })

  it('exports biometric error classes', () => {
    expect(typeof BiometricUnavailableError).toBe('function')
    expect(typeof BiometricCodeRejectedError).toBe('function')
    expect(typeof BiometricNonDeterministicError).toBe('function')
  })
})

describe('browser entry', () => {
  it('offers idle detection only through attachActivityTracking (requestLock required)', () => {
    expect(typeof browserEntry.attachActivityTracking).toBe('function')
    // Bug #5: a bare idle timer let an app lock every sibling on its own
    // inactivity. The renderer must not be able to reach it any more.
    expect('createActivityTracker' in browserEntry).toBe(false)
  })
})
