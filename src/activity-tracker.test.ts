import { describe, it, expect, vi, afterEach } from 'vitest'
import { createActivityTracker } from './activity-tracker'

afterEach(() => {
  vi.useRealTimers()
})

describe('activity-tracker', () => {
  it('fires onIdle after timeoutMs of inactivity', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createActivityTracker({ timeoutMs: 1000, onIdle })
    t.start()

    vi.advanceTimersByTime(999)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('recordActivity resets the idle timer', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createActivityTracker({ timeoutMs: 1000, onIdle })
    t.start()

    vi.advanceTimersByTime(800)
    t.recordActivity()
    vi.advanceTimersByTime(800)
    expect(onIdle).not.toHaveBeenCalled() // would have fired at 1000ms without reset

    vi.advanceTimersByTime(300)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('start is idempotent', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createActivityTracker({ timeoutMs: 1000, onIdle })
    t.start()
    t.start() // second call should not double-schedule
    vi.advanceTimersByTime(1100)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('stop prevents future onIdle calls', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createActivityTracker({ timeoutMs: 1000, onIdle })
    t.start()
    vi.advanceTimersByTime(500)
    t.stop()
    vi.advanceTimersByTime(2000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('recordActivity is no-op when stopped', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createActivityTracker({ timeoutMs: 1000, onIdle })
    t.start()
    t.stop()
    t.recordActivity()
    vi.advanceTimersByTime(2000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('timeoutMs=0 disables idle detection', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createActivityTracker({ timeoutMs: 0, onIdle })
    t.start()
    t.recordActivity()
    vi.advanceTimersByTime(60_000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('isActive reflects start/stop', () => {
    const t = createActivityTracker({ timeoutMs: 1000, onIdle: () => {} })
    expect(t.isActive()).toBe(false)
    t.start()
    expect(t.isActive()).toBe(true)
    t.stop()
    expect(t.isActive()).toBe(false)
  })

  it('isolates an onIdle that throws (logs but does not crash)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    const onIdle = () => { throw new Error('boom') }
    const t = createActivityTracker({ timeoutMs: 100, onIdle })
    t.start()
    expect(() => vi.advanceTimersByTime(200)).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('multiple recordActivity calls all reset (last wins)', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createActivityTracker({ timeoutMs: 1000, onIdle })
    t.start()

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(500)
      t.recordActivity()
    }
    // We've spent 2500ms total but each recordActivity reset the timer
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1100)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })
})
