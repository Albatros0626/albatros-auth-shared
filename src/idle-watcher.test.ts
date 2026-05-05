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

  it('fires onLock on next tick if session is already invalid at start', async () => {
    const session = makeStubSession(makeExpiredState())
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 100 })
    w.start()

    // v2.0.1+: initial check is deferred to the next macrotask so unlock
    // handlers that flip state synchronously can finish before we read
    // session.bin. Wait a tick for the deferred check to fire.
    await new Promise((r) => setTimeout(r, 0))

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

  it('isolates an onLock that throws (logs but does not crash)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = makeStubSession(makeExpiredState())
    const w = createIdleWatcher({
      sessionService: session,
      onLock: () => { throw new Error('boom') },
      pollMs: 100,
    })
    expect(() => w.start()).not.toThrow()
    // Wait for the deferred initial check (v2.0.1+) to fire onLock.
    await new Promise((r) => setTimeout(r, 0))
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
    w.stop()
  })

  it('uses default pollMs when not specified', () => {
    const session = makeStubSession(makeValidState())
    const w = createIdleWatcher({ sessionService: session, onLock: () => {} })
    w.start()
    expect(w.isRunning()).toBe(true)
    w.stop()
  })

  // Sleep detection (v1.2.0+) -----------------------------------------------

  it('grants grace period when system wakes up from sleep (no immediate lock)', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({
      sessionService: session,
      onLock,
      pollMs: 100,
      sleepDetectionMultiplier: 3,
    })
    w.start()

    // Simulate system sleep by jumping the clock forward by 60s.
    // setSystemTime moves Date.now() without firing queued timers.
    vi.setSystemTime(Date.now() + 60_000)

    // Mark session as expired and trigger a check via watch.
    // drift = 60000 > pollMs * 3 (= 300) → sleep detected.
    session.setMockState(makeExpiredState())
    session.triggerWatch()

    expect(session.recordActivity).toHaveBeenCalledTimes(1)
    expect(onLock).not.toHaveBeenCalled()
    w.stop()
  })

  it('locks normally on a tick after the sleep wake-up grace', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({
      sessionService: session,
      onLock,
      pollMs: 100,
      sleepDetectionMultiplier: 3,
    })
    w.start()

    // Wake-up tick: drift large → grace, no lock
    vi.setSystemTime(Date.now() + 60_000)
    session.setMockState(makeExpiredState())
    session.triggerWatch()
    expect(onLock).not.toHaveBeenCalled()

    // Subsequent setInterval tick (drift small) detects expiration → lock fires
    vi.advanceTimersByTime(100)
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('legacy behavior with sleepDetectionMultiplier: Infinity (lock immediately on wake)', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({
      sessionService: session,
      onLock,
      pollMs: 100,
      sleepDetectionMultiplier: Infinity,
    })
    w.start()

    vi.setSystemTime(Date.now() + 60_000)
    session.setMockState(makeExpiredState())
    session.triggerWatch()

    // No sleep detection → lock fires immediately
    expect(session.recordActivity).not.toHaveBeenCalled()
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('does not trip sleep detection on a normal poll cadence', () => {
    vi.useFakeTimers()
    const session = makeStubSession(makeValidState())
    const onLock = vi.fn()
    const w = createIdleWatcher({
      sessionService: session,
      onLock,
      pollMs: 100,
      sleepDetectionMultiplier: 3,
    })
    w.start()

    // 5 normal ticks (drift = 100ms each, < 300ms threshold)
    vi.advanceTimersByTime(500)

    expect(session.recordActivity).not.toHaveBeenCalled()
    expect(onLock).not.toHaveBeenCalled()
    w.stop()
  })

  it('exports DEFAULT_SLEEP_DETECTION_MULTIPLIER', async () => {
    const mod = await import('./idle-watcher')
    expect(mod.DEFAULT_SLEEP_DETECTION_MULTIPLIER).toBe(3)
  })

  // Defense-in-depth (v2.0.1+) ----------------------------------------------

  it('deferred initial check tolerates same-tick session.bin updates', async () => {
    // Reproduces the bug fixed in v2.0.1: a caller that flips authState first
    // and then writes session.bin synchronously (in that order) used to race
    // the watcher's immediate check, which read stale "locked" state and
    // re-fired onLock. With the deferred initial check, the synchronous
    // session.bin write completes before the check runs.
    const lockedState = makeLockedState()
    const validState = makeValidState()
    const session = makeStubSession(lockedState)
    const onLock = vi.fn()
    const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 100 })

    // Simulate the unlock handler: start() the watcher, then SAME TICK
    // overwrite session.bin to the unlocked state (as recordUnlock would do).
    w.start()
    session.setMockState(validState)

    // Wait for the deferred check.
    await new Promise((r) => setTimeout(r, 0))

    // The deferred check sees the FRESH valid state, not the stale locked one.
    expect(onLock).not.toHaveBeenCalled()
    expect(w.isRunning()).toBe(true)
    w.stop()
  })
})
