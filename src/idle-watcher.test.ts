import { describe, it, expect, vi, afterEach } from 'vitest'
import { createIdleWatcher } from './idle-watcher'
import type { SessionService } from './session-service'
import type { SessionState } from './types'

afterEach(() => {
  vi.useRealTimers()
})

interface StubSessionService extends SessionService {
  setMockState(state: SessionState | null): void
  triggerWatch(): void
}

function makeStubSession(initial: SessionState | null = null): StubSessionService {
  let mockState: SessionState | null = initial
  let watchListener: ((state: SessionState | null) => void) | null = null

  const stub: StubSessionService = {
    read: () => mockState,
    recordUnlock: vi.fn() as unknown as SessionService['recordUnlock'],
    recordLock: vi.fn() as unknown as SessionService['recordLock'],
    recordActivity: vi.fn() as unknown as SessionService['recordActivity'],
    watch: ((cb) => {
      watchListener = cb
      return () => { watchListener = null }
    }) as SessionService['watch'],
    __flushPendingForTests: vi.fn() as unknown as SessionService['__flushPendingForTests'],
    setMockState(s: SessionState | null) {
      mockState = s
    },
    triggerWatch() {
      if (watchListener) watchListener(mockState)
    },
  }
  return stub
}

function makeValidState(): SessionState {
  return {
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
}

function makeExpiredState(): SessionState {
  return { ...makeValidState(), isExpired: true, isValid: false }
}

function makeLockedState(): SessionState {
  return {
    ...makeValidState(),
    lockedAt: new Date().toISOString(),
    isLocked: true,
    isValid: false,
  }
}

describe('idle-watcher', () => {
  it('does nothing when session is valid', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 100 })
    w.start()

    vi.advanceTimersByTime(500)
    expect(onLock).not.toHaveBeenCalled()
    w.stop()
  })

  it('fires onLock when session becomes expired (poll-detected)', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 100 })
    w.start()

    session.setMockState(makeExpiredState())
    vi.advanceTimersByTime(150)

    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('fires onLock when session is locked externally (watch-detected)', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 999_999 })
    w.start()

    session.setMockState(makeLockedState())
    session.triggerWatch()

    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('fires onLock immediately if session is already invalid at start', () => {
    const session = makeStubSession(makeExpiredState())
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 100 })
    w.start()

    expect(onLock).toHaveBeenCalledTimes(1)
    expect(w.isRunning()).toBe(false) // auto-stopped after firing
  })

  it('onLock fires only once even with multiple poll/watch hits', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 50 })
    w.start()

    session.setMockState(makeExpiredState())
    vi.advanceTimersByTime(60)
    session.triggerWatch()
    session.triggerWatch()
    vi.advanceTimersByTime(200)

    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('stop prevents further onLock calls', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 50 })
    w.start()
    w.stop()

    session.setMockState(makeExpiredState())
    vi.advanceTimersByTime(500)
    session.triggerWatch()

    expect(onLock).not.toHaveBeenCalled()
  })

  it('does not fire when session is null (no session yet)', () => {
    vi.useFakeTimers()
    const session = makeStubSession(null)
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 50 })
    w.start()

    vi.advanceTimersByTime(500)
    expect(onLock).not.toHaveBeenCalled()
    w.stop()
  })

  it('start is idempotent', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 50 })
    w.start()
    w.start() // second call no-op

    session.setMockState(makeExpiredState())
    vi.advanceTimersByTime(100)
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('isRunning reflects state', () => {
    const session = makeStubSession(makeValidState())
    const w = createIdleWatcher({ sessionService: session, onLock: () => {}, pollMs: 100 })
    expect(w.isRunning()).toBe(false)
    w.start()
    expect(w.isRunning()).toBe(true)
    w.stop()
    expect(w.isRunning()).toBe(false)
  })

  it('isolates an onLock that throws (logs but does not crash)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = makeStubSession(makeExpiredState())
    const w = createIdleWatcher({
      sessionService: session,
      onLock: () => { throw new Error('boom') },
      pollMs: 100,
    })
    expect(() => w.start()).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('uses default pollMs when not specified', () => {
    const session = makeStubSession(makeValidState())
    const w = createIdleWatcher({ sessionService: session, onLock: () => {} })
    w.start()
    expect(w.isRunning()).toBe(true)
    w.stop()
  })
})
