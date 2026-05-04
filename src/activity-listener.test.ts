import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  attachActivityTracking,
  DEFAULT_ACTIVITY_EVENTS,
  DEFAULT_IPC_THROTTLE_MS,
  type ActivityEventTarget,
} from './activity-listener'

afterEach(() => {
  vi.useRealTimers()
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

describe('attachActivityTracking', () => {
  it('attaches listeners for the default events', () => {
    const target = makeStubTarget()
    const dispose = attachActivityTracking({
      target,
      timeoutMs: 1000,
      onIdle: () => {},
    })
    expect(target.listenerCount()).toBe(DEFAULT_ACTIVITY_EVENTS.length)
    dispose()
  })

  it('removes listeners on dispose', () => {
    const target = makeStubTarget()
    const dispose = attachActivityTracking({
      target,
      timeoutMs: 1000,
      onIdle: () => {},
    })
    dispose()
    expect(target.listenerCount()).toBe(0)
  })

  it('fires onIdle after timeoutMs of inactivity', () => {
    vi.useFakeTimers()
    const target = makeStubTarget()
    const onIdle = vi.fn()
    attachActivityTracking({ target, timeoutMs: 1000, onIdle })

    vi.advanceTimersByTime(999)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('events reset the idle timer', () => {
    vi.useFakeTimers()
    const target = makeStubTarget()
    const onIdle = vi.fn()
    attachActivityTracking({ target, timeoutMs: 1000, onIdle })

    vi.advanceTimersByTime(800)
    target.fire('mousemove')
    vi.advanceTimersByTime(800)
    expect(onIdle).not.toHaveBeenCalled() // timer was reset

    vi.advanceTimersByTime(300)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('throttles onActivity to throttleMs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const target = makeStubTarget()
    const onActivity = vi.fn()
    attachActivityTracking({
      target,
      timeoutMs: 60_000,
      onIdle: () => {},
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
        onIdle: () => {},
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
      onIdle: () => {},
    })
    expect(target.listenerCount()).toBe(0)
    expect(() => dispose()).not.toThrow()
  })

  it('respects a custom events list', () => {
    const target = makeStubTarget()
    attachActivityTracking({
      target,
      timeoutMs: 1000,
      onIdle: () => {},
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
