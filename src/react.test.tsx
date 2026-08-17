// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useIdleLock, useBiometricUnlock } from './react'
import type { BiometricUnlockResult } from './types'

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

// =============================================================================
// useBiometricUnlock
// =============================================================================

/** A pending unlock the test settles by hand, mimicking the Hello prompt. */
function deferredUnlock() {
  let settle!: (r: BiometricUnlockResult) => void
  let calls = 0
  const unlock = (): Promise<BiometricUnlockResult> => {
    calls += 1
    return new Promise<BiometricUnlockResult>((resolve) => { settle = resolve })
  }
  return {
    unlock,
    resolveWith: (r: BiometricUnlockResult) => act(async () => { settle(r) }),
    get calls() { return calls },
  }
}

describe('useBiometricUnlock', () => {
  it('never prompts on mount — the prompt must follow a click', () => {
    // A prompt raised without foreground is what triggers
    // WINBIO_E_INVALID_TICKET; only a click guarantees focus.
    const d = deferredUnlock()
    const { result } = renderHook(() => useBiometricUnlock({ unlock: d.unlock }))

    expect(d.calls).toBe(0)
    expect(result.current.pending).toBe(false)
  })

  it('reports pending while the prompt is up, and clears it on success', async () => {
    const d = deferredUnlock()
    const onUnlocked = vi.fn()
    const { result } = renderHook(() => useBiometricUnlock({ unlock: d.unlock, onUnlocked }))

    act(() => { result.current.trigger() })
    expect(result.current.pending).toBe(true)

    await d.resolveWith({ ok: true })
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(onUnlocked).toHaveBeenCalledTimes(1)
    expect(result.current.failure).toBeNull()
  })

  it('exposes the failure without calling onUnlocked', async () => {
    const d = deferredUnlock()
    const onUnlocked = vi.fn()
    const { result } = renderHook(() => useBiometricUnlock({ unlock: d.unlock, onUnlocked }))

    act(() => { result.current.trigger() })
    await d.resolveWith({ ok: false, failure: 'rejected', reason: 'cancelled' })

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.failure).toMatchObject({ failure: 'rejected', reason: 'cancelled' })
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it('ignores a second trigger while one is pending', async () => {
    const d = deferredUnlock()
    const { result } = renderHook(() => useBiometricUnlock({ unlock: d.unlock }))

    act(() => { result.current.trigger() })
    act(() => { result.current.trigger() })

    // One click, one prompt — a double-click must not race two Hello dialogs.
    expect(d.calls).toBe(1)
    await d.resolveWith({ ok: true })
  })

  it('clears a previous failure when a new attempt starts', async () => {
    const d1 = deferredUnlock()
    const { result, rerender } = renderHook(
      ({ u }: { u: () => Promise<BiometricUnlockResult> }) => useBiometricUnlock({ unlock: u }),
      { initialProps: { u: d1.unlock } },
    )

    act(() => { result.current.trigger() })
    await d1.resolveWith({ ok: false, failure: 'rejected', reason: 'cancelled' })
    await waitFor(() => expect(result.current.failure).not.toBeNull())

    const d2 = deferredUnlock()
    rerender({ u: d2.unlock })
    act(() => { result.current.trigger() })
    expect(result.current.failure).toBeNull()
    await d2.resolveWith({ ok: true })
  })

  it('uses the LATEST unlock callback, not the mount-time closure', async () => {
    const d1 = deferredUnlock()
    const d2 = deferredUnlock()
    const { result, rerender } = renderHook(
      ({ u }: { u: () => Promise<BiometricUnlockResult> }) => useBiometricUnlock({ unlock: u }),
      { initialProps: { u: d1.unlock } },
    )

    rerender({ u: d2.unlock })
    act(() => { result.current.trigger() })

    expect(d1.calls).toBe(0)
    expect(d2.calls).toBe(1)
    await d2.resolveWith({ ok: true })
  })

  it('surfaces an IPC-level throw as a rejection instead of letting it escape', async () => {
    const unlock = vi.fn().mockRejectedValue(new Error('IPC channel closed'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onUnlocked = vi.fn()
    const { result } = renderHook(() => useBiometricUnlock({ unlock, onUnlocked }))

    await act(async () => { result.current.trigger() })

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.failure).toMatchObject({ failure: 'rejected', reason: 'unknown' })
    expect(onUnlocked).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('drops a result that lands after unmount', async () => {
    const d = deferredUnlock()
    const onUnlocked = vi.fn()
    const { result, unmount } = renderHook(() => useBiometricUnlock({ unlock: d.unlock, onUnlocked }))

    act(() => { result.current.trigger() })
    unmount()
    // The user typed their code and moved on while Hello was still up.
    await d.resolveWith({ ok: true })

    expect(onUnlocked).not.toHaveBeenCalled()
  })
})
