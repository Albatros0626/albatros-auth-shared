import { describe, it, expect, vi } from 'vitest'
import { createAuthState } from './auth-state'

describe('auth-state', () => {
  it('starts locked by default', () => {
    const state = createAuthState()
    expect(state.isUnlocked()).toBe(false)
  })

  it('reflects setUnlocked(true)', () => {
    const state = createAuthState()
    state.setUnlocked(true)
    expect(state.isUnlocked()).toBe(true)
  })

  it('reflects setUnlocked(false)', () => {
    const state = createAuthState()
    state.setUnlocked(true)
    state.setUnlocked(false)
    expect(state.isUnlocked()).toBe(false)
  })

  describe('onUnlockChange', () => {
    it('fires the listener on transition true → false', () => {
      const state = createAuthState()
      const listener = vi.fn()
      state.onUnlockChange(listener)
      state.setUnlocked(true)
      state.setUnlocked(false)
      expect(listener).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenNthCalledWith(1, true)
      expect(listener).toHaveBeenNthCalledWith(2, false)
    })

    it('does not fire the listener if value is unchanged', () => {
      const state = createAuthState()
      const listener = vi.fn()
      state.onUnlockChange(listener)
      state.setUnlocked(false) // already false
      expect(listener).not.toHaveBeenCalled()

      state.setUnlocked(true)
      state.setUnlocked(true) // already true
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('returns an unsubscribe function', () => {
      const state = createAuthState()
      const listener = vi.fn()
      const unsubscribe = state.onUnlockChange(listener)
      state.setUnlocked(true)
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()
      state.setUnlocked(false)
      expect(listener).toHaveBeenCalledTimes(1) // not called again
    })

    it('supports multiple listeners', () => {
      const state = createAuthState()
      const a = vi.fn()
      const b = vi.fn()
      state.onUnlockChange(a)
      state.onUnlockChange(b)
      state.setUnlocked(true)
      expect(a).toHaveBeenCalledWith(true)
      expect(b).toHaveBeenCalledWith(true)
    })

    it('keeps other listeners running if one throws', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const state = createAuthState()
      const bad = () => { throw new Error('listener boom') }
      const good = vi.fn()
      state.onUnlockChange(bad)
      state.onUnlockChange(good)
      state.setUnlocked(true)
      expect(good).toHaveBeenCalledWith(true)
      expect(errorSpy).toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('two state instances are independent', () => {
      const a = createAuthState()
      const b = createAuthState()
      a.setUnlocked(true)
      expect(a.isUnlocked()).toBe(true)
      expect(b.isUnlocked()).toBe(false)
    })
  })
})
