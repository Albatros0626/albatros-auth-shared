import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  attachActivityTracking,
  DEFAULT_ACTIVITY_EVENTS,
  DEFAULT_IPC_THROTTLE_MS,
  type ActivityEventTarget,
} from './activity-listener'
import type { RequestLockResult } from './types'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface StubTarget extends ActivityEventTarget {
  fire(event: string): void
  listenerCount(): number
}

function makeStubTarget(): StubTarget {
  const listeners = new Map<string, () => void>()
  return {
    addEventListener(event, listener) {
      listeners.set(event, listener)
    },
    removeEventListener(event) {
      listeners.delete(event)
    },
    fire(event) {
      const l = listeners.get(event)
      if (l) l()
    },
    listenerCount() {
      return listeners.size
    },
  }
}

/** The main process's answer while another Albatros app is active. */
const refused = (): Promise<RequestLockResult> =>
  Promise.resolve({ locked: false, reason: 'cross-app-active' })

describe('attachActivityTracking', () => {
  it('attaches listeners for the default events', () => {
    const target = makeStubTarget()
    const dispose = attachActivityTracking({
      target,
      timeoutMs: 1000,
      requestLock: refused,
    })
    expect(target.listenerCount()).toBe(DEFAULT_ACTIVITY_EVENTS.length)
    dispose()
  })

  it('removes listeners on dispose', () => {
    const target = makeStubTarget()
    const dispose = attachActivityTracking({
      target,
      timeoutMs: 1000,
      requestLock: refused,
    })
    dispose()
    expect(target.listenerCount()).toBe(0)
  })

  it('calls requestLock after timeoutMs of inactivity', () => {
    vi.useFakeTimers()
    const target = makeStubTarget()
    const requestLock = vi.fn(refused)
    attachActivityTracking({ target, timeoutMs: 1000, requestLock })

    vi.advanceTimersByTime(999)
    expect(requestLock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2)
    expect(requestLock).toHaveBeenCalledTimes(1)
  })

  it('events reset the idle timer', () => {
    vi.useFakeTimers()
    const target = makeStubTarget()
    const requestLock = vi.fn(refused)
    attachActivityTracking({ target, timeoutMs: 1000, requestLock })

    vi.advanceTimersByTime(800)
    target.fire('mousemove')
    vi.advanceTimersByTime(800)
    expect(requestLock).not.toHaveBeenCalled() // timer was reset

    vi.advanceTimersByTime(300)
    expect(requestLock).toHaveBeenCalledTimes(1)
  })

  it('after a refusal, stays dormant until the next event in this window', () => {
    vi.useFakeTimers()
    const target = makeStubTarget()
    const requestLock = vi.fn(refused)
    attachActivityTracking({ target, timeoutMs: 1000, requestLock })

    vi.advanceTimersByTime(5000)
    expect(requestLock).toHaveBeenCalledTimes(1) // no retry loop

    target.fire('keydown')
    vi.advanceTimersByTime(1001)
    expect(requestLock).toHaveBeenCalledTimes(2)
  })

  it('logs a rejected requestLock instead of leaking an unhandled rejection', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('IPC unavailable')
    const target = makeStubTarget()
    attachActivityTracking({
      target,
      timeoutMs: 1000,
      requestLock: () => Promise.reject(failure),
    })

    await vi.advanceTimersByTimeAsync(1001)

    expect(errorSpy).toHaveBeenCalledWith('[activity-listener] requestLock failed:', failure)
  })

  it('throttles onActivity to throttleMs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const target = makeStubTarget()
    const onActivity = vi.fn()
    attachActivityTracking({
      target,
      timeoutMs: 60_000,
      requestLock: refused,
      onActivity,
      throttleMs: 1000,
    })

    target.fire('mousemove') // first → fires
    expect(onActivity).toHaveBeenCalledTimes(1)

    vi.setSystemTime(500)
    target.fire('mousemove') // throttled
    expect(onActivity).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1500)
    target.fire('mousemove') // > 1000ms → fires
    expect(onActivity).toHaveBeenCalledTimes(2)
  })

  it('does not call onActivity if not provided', () => {
    const target = makeStubTarget()
    expect(() => {
      const dispose = attachActivityTracking({
        target,
        timeoutMs: 1000,
        requestLock: refused,
      })
      target.fire('mousemove')
      dispose()
    }).not.toThrow()
  })

  it('returns a no-op dispose when timeoutMs <= 0', () => {
    const target = makeStubTarget()
    const dispose = attachActivityTracking({
      target,
      timeoutMs: 0,
      requestLock: refused,
    })
    expect(target.listenerCount()).toBe(0)
    expect(() => dispose()).not.toThrow()
  })

  it('respects a custom events list', () => {
    const target = makeStubTarget()
    attachActivityTracking({
      target,
      timeoutMs: 1000,
      requestLock: refused,
      events: ['custom-evt'],
    })
    expect(target.listenerCount()).toBe(1)
  })

  it('exports the default constants', () => {
    expect(DEFAULT_ACTIVITY_EVENTS).toContain('mousemove')
    expect(DEFAULT_ACTIVITY_EVENTS).toContain('keydown')
    expect(DEFAULT_IPC_THROTTLE_MS).toBe(1000)
  })
})
