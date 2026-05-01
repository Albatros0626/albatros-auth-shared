import { describe, it, expect, vi } from 'vitest'
import { createAuthState } from './auth-state'
import {
  createGuardedHandle,
  NOT_UNLOCKED_ERROR,
  type IpcMainLike,
  type IpcHandler,
} from './guarded-handle'

interface MockIpcMain extends IpcMainLike {
  registered: Map<string, IpcHandler>
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

function makeMockIpcMain(): MockIpcMain {
  const registered = new Map<string, IpcHandler>()
  return {
    registered,
    handle(channel, listener) {
      registered.set(channel, listener)
    },
    invoke(channel, ...args) {
      const listener = registered.get(channel)
      if (!listener) throw new Error(`No handler for ${channel}`)
      return Promise.resolve(listener({} /* event */, ...args))
    },
  }
}

describe('guarded-handle', () => {
  it('registers the channel on ipcMain', () => {
    const ipcMain = makeMockIpcMain()
    const authState = createAuthState()
    const guardedHandle = createGuardedHandle({ ipcMain, authState })

    guardedHandle('contacts:getAll', () => 'ok')

    expect(ipcMain.registered.has('contacts:getAll')).toBe(true)
  })

  it('returns NOT_UNLOCKED_ERROR when locked', async () => {
    const ipcMain = makeMockIpcMain()
    const authState = createAuthState()
    const guardedHandle = createGuardedHandle({ ipcMain, authState })

    const innerListener = vi.fn(() => 'ok')
    guardedHandle('contacts:getAll', innerListener)

    const result = await ipcMain.invoke('contacts:getAll')

    expect(result).toEqual(NOT_UNLOCKED_ERROR)
    expect(innerListener).not.toHaveBeenCalled()
  })

  it('NOT_UNLOCKED_ERROR has the right shape', () => {
    expect(NOT_UNLOCKED_ERROR.success).toBe(false)
    expect(NOT_UNLOCKED_ERROR.error.code).toBe('NOT_UNLOCKED')
    expect(NOT_UNLOCKED_ERROR.error.message).toBeTruthy()
  })

  it('forwards to inner listener when unlocked', async () => {
    const ipcMain = makeMockIpcMain()
    const authState = createAuthState()
    const guardedHandle = createGuardedHandle({ ipcMain, authState })

    authState.setUnlocked(true)

    const innerListener = vi.fn(() => 'inner-result')
    guardedHandle('contacts:getAll', innerListener)

    const result = await ipcMain.invoke('contacts:getAll', 'arg1', 42)

    expect(result).toBe('inner-result')
    expect(innerListener).toHaveBeenCalledTimes(1)
    expect(innerListener).toHaveBeenCalledWith({}, 'arg1', 42)
  })

  it('lock between handler registration and invocation rejects the call', async () => {
    const ipcMain = makeMockIpcMain()
    const authState = createAuthState()
    const guardedHandle = createGuardedHandle({ ipcMain, authState })

    authState.setUnlocked(true)
    const innerListener = vi.fn(() => 'ok')
    guardedHandle('contacts:getAll', innerListener)

    // Re-lock before invoking
    authState.setUnlocked(false)

    const result = await ipcMain.invoke('contacts:getAll')
    expect(result).toEqual(NOT_UNLOCKED_ERROR)
    expect(innerListener).not.toHaveBeenCalled()
  })

  it('async listener result is awaited and returned', async () => {
    const ipcMain = makeMockIpcMain()
    const authState = createAuthState()
    const guardedHandle = createGuardedHandle({ ipcMain, authState })
    authState.setUnlocked(true)

    guardedHandle('async:op', async () => {
      await new Promise(r => setTimeout(r, 5))
      return 'async-done'
    })

    const result = await ipcMain.invoke('async:op')
    expect(result).toBe('async-done')
  })

  it('listener throw propagates to caller', async () => {
    const ipcMain = makeMockIpcMain()
    const authState = createAuthState()
    const guardedHandle = createGuardedHandle({ ipcMain, authState })
    authState.setUnlocked(true)

    guardedHandle('boom', () => { throw new Error('inner') })

    await expect(ipcMain.invoke('boom')).rejects.toThrow('inner')
  })

  it('multiple guarded channels share the same auth state', async () => {
    const ipcMain = makeMockIpcMain()
    const authState = createAuthState()
    const guardedHandle = createGuardedHandle({ ipcMain, authState })

    guardedHandle('a', () => 'A')
    guardedHandle('b', () => 'B')

    expect(await ipcMain.invoke('a')).toEqual(NOT_UNLOCKED_ERROR)
    expect(await ipcMain.invoke('b')).toEqual(NOT_UNLOCKED_ERROR)

    authState.setUnlocked(true)

    expect(await ipcMain.invoke('a')).toBe('A')
    expect(await ipcMain.invoke('b')).toBe('B')
  })
})
