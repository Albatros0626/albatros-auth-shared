// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIdleLock } from './react'

afterEach(() => {
  vi.useRealTimers()
})

describe('useIdleLock', () => {
  it('attaches DOM listeners on mount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    renderHook(() => useIdleLock({
      timeoutMinutes: 10,
      onLock: () => {},
    }))

    expect(addSpy).toHaveBeenCalledWith('mousemove', expect.any(Function), expect.any(Object))
    addSpy.mockRestore()
  })

  it('does not attach listeners when timeoutMinutes <= 0', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    renderHook(() => useIdleLock({
      timeoutMinutes: 0,
      onLock: () => {},
    }))

    expect(addSpy).not.toHaveBeenCalled()
    addSpy.mockRestore()
  })

  it('detaches listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useIdleLock({
      timeoutMinutes: 10,
      onLock: () => {},
    }))
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    removeSpy.mockRestore()
  })

  it('does NOT re-run the effect when callbacks change (ref pattern)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')

    let onLockCalls = 0
    const { rerender } = renderHook(
      ({ onLock }: { onLock: () => void }) =>
        useIdleLock({ timeoutMinutes: 10, onLock }),
      {
        initialProps: { onLock: () => { onLockCalls++ } },
      }
    )

    const initialAddCalls = addSpy.mock.calls.length

    // Re-render with a brand-new onLock arrow function (the foot-gun).
    rerender({ onLock: () => { onLockCalls++ } })

    // Effect must NOT have run again — listener count stays the same.
    expect(addSpy.mock.calls.length).toBe(initialAddCalls)

    addSpy.mockRestore()
  })

  it('does re-run the effect when timeoutMinutes changes', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    const { rerender } = renderHook(
      ({ minutes }: { minutes: number }) =>
        useIdleLock({ minutes, timeoutMinutes: minutes, onLock: () => {} } as any),
      {
        initialProps: { minutes: 10 },
      }
    )
    const initialRemoveCalls = removeSpy.mock.calls.length

    rerender({ minutes: 20 })

    // Cleanup should have run (listeners removed) before re-attaching.
    expect(removeSpy.mock.calls.length).toBeGreaterThan(initialRemoveCalls)
    removeSpy.mockRestore()
  })

  it('calls the LATEST onLock when idle fires (not the original closure)', () => {
    vi.useFakeTimers()
    let calls: string[] = []

    const { rerender } = renderHook(
      ({ tag }: { tag: string }) =>
        useIdleLock({
          timeoutMinutes: 1, // 60s
          onLock: () => { calls.push(tag) },
        }),
      { initialProps: { tag: 'first' } }
    )

    // Re-render with a different onLock that pushes 'second'
    rerender({ tag: 'second' })

    // Advance past the idle timeout
    vi.advanceTimersByTime(60_001)

    // The ref should have captured the LATEST onLock → tag 'second'
    expect(calls).toEqual(['second'])
  })
})
