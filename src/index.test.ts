import { describe, it, expect } from 'vitest'
import {
  VERSION,
  createAuthService,
  validateCode,
  normalizeAnswer,
  RECOVERY_QUESTIONS,
  VaultVersionUnsupportedError,
  VaultNotInitializedError,
} from './index'

describe('package public API', () => {
  it('exports VERSION constant', () => {
    expect(VERSION).toBe('0.6.0')
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
})
