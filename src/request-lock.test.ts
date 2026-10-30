import { describe, it, expect, vi } from 'vitest'
import { createRequestLockHandler } from './request-lock'
import type { SessionState } from './types'

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  const base: SessionState = {
    unlockedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    lockTimeoutMinutes: 10,
    lockedAt: null,
    unlockerAppId: 'test',
    sessionToken: 'tok',
    isLocked: false,
    isExpired: false,
    isValid: true,
  }
  const state = { ...base, ...overrides }
  return { ...state, isValid: !state.isLocked && !state.isExpired }
}

function makeDeps(state: SessionState | null) {
  return {
    sessionService: { read: vi.fn(() => state), recordLock: vi.fn() },
    authState: { setUnlocked: vi.fn() },
  }
}

describe('createRequestLockHandler', () => {
  it('refuses while another Albatros app recorded activity within the timeout', () => {
    const deps = makeDeps(makeState())
    const requestLock = createRequestLockHandler(deps)

    expect(requestLock()).toEqual({ locked: false, reason: 'cross-app-active' })
    expect(deps.sessionService.recordLock).not.toHaveBeenCalled()
    expect(deps.authState.setUnlocked).not.toHaveBeenCalled()
  })

  it('locks every app once the shared session has expired', () => {
    const deps = makeDeps(makeState({ isExpired: true }))
    const requestLock = createRequestLockHandler(deps)

    expect(requestLock()).toEqual({ locked: true, reason: 'expired' })
    expect(deps.sessionService.recordLock).toHaveBeenCalledTimes(1)
    expect(deps.authState.setUnlocked).toHaveBeenCalledWith(false)
  })

  it('does not rewrite a lock another app already recorded', () => {
    const deps = makeDeps(makeState({ isLocked: true, lockedAt: new Date().toISOString() }))
    const requestLock = createRequestLockHandler(deps)

    expect(requestLock()).toEqual({ locked: true, reason: 'already-locked' })
    expect(deps.sessionService.recordLock).not.toHaveBeenCalled()
  })

  it('does not lock without a shared session', () => {
    const deps = makeDeps(null)
    const requestLock = createRequestLockHandler(deps)

    expect(requestLock()).toEqual({ locked: false, reason: 'no-session' })
    expect(deps.sessionService.recordLock).not.toHaveBeenCalled()
  })

  it('reads the session on every call, not once at creation', () => {
    let state = makeState()
    const sessionService = { read: vi.fn(() => state), recordLock: vi.fn() }
    const requestLock = createRequestLockHandler({ sessionService, authState: { setUnlocked: vi.fn() } })

    expect(requestLock().locked).toBe(false)
    state = makeState({ isExpired: true })
    expect(requestLock().locked).toBe(true)
  })

  it('ignores its arguments, so it can be passed to ipcMain.handle as is', () => {
    const deps = makeDeps(makeState({ isExpired: true }))
    const handler = createRequestLockHandler(deps) as (...args: unknown[]) => unknown

    expect(handler({ sender: {} }, 'unexpected')).toEqual({ locked: true, reason: 'expired' })
  })
})
