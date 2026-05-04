import { describe, it, expect } from 'vitest'
import { isGuardedError, type GuardedError } from './guarded-error-types'
import { NOT_UNLOCKED_ERROR } from './guarded-handle'

describe('isGuardedError', () => {
  it('matches the canonical NOT_UNLOCKED_ERROR constant', () => {
    expect(isGuardedError(NOT_UNLOCKED_ERROR)).toBe(true)
  })

  it('matches a hand-rolled envelope with the right shape', () => {
    const x: GuardedError = {
      success: false,
      error: { code: 'NOT_UNLOCKED', message: 'locked' },
    }
    expect(isGuardedError(x)).toBe(true)
  })

  it('rejects success: true', () => {
    expect(isGuardedError({ success: true, error: { code: 'NOT_UNLOCKED', message: '' } })).toBe(false)
  })

  it('rejects unknown error.code', () => {
    expect(isGuardedError({ success: false, error: { code: 'OTHER', message: '' } })).toBe(false)
  })

  it('rejects null and primitives', () => {
    expect(isGuardedError(null)).toBe(false)
    expect(isGuardedError(undefined)).toBe(false)
    expect(isGuardedError(42)).toBe(false)
    expect(isGuardedError('locked')).toBe(false)
    expect(isGuardedError(false)).toBe(false)
  })

  it('rejects objects without an error field', () => {
    expect(isGuardedError({ success: false })).toBe(false)
  })

  it('rejects arrays (the real payload shape)', () => {
    expect(isGuardedError([])).toBe(false)
    expect(isGuardedError([{ id: 1 }])).toBe(false)
  })

  it('narrows the type when the guard returns true', () => {
    const x: unknown = NOT_UNLOCKED_ERROR
    if (isGuardedError(x)) {
      // Must compile: x is now GuardedError
      expect(x.error.code).toBe('NOT_UNLOCKED')
      expect(x.success).toBe(false)
    } else {
      throw new Error('guard should have matched')
    }
  })
})
