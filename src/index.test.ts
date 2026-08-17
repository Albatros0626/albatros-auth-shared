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
} from './index'

describe('package public API', () => {
  it('exports VERSION constant', () => {
    expect(VERSION).toBe('2.1.1')
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
