import type { AuthState } from './auth-state'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcHandler = (event: any, ...args: any[]) => any

export interface IpcMainLike {
  handle(channel: string, listener: IpcHandler): void
}

export interface CreateGuardedHandleOpts {
  ipcMain: IpcMainLike
  authState: AuthState
}

export interface GuardedError {
  success: false
  error: {
    code: 'NOT_UNLOCKED'
    message: string
  }
}

export const NOT_UNLOCKED_ERROR: GuardedError = {
  success: false,
  error: {
    code: 'NOT_UNLOCKED',
    message: 'Application verrouillée, déverrouillez-la pour continuer.',
  },
}

export type GuardedHandle = (channel: string, listener: IpcHandler) => void

export function createGuardedHandle(opts: CreateGuardedHandleOpts): GuardedHandle {
  const { ipcMain, authState } = opts

  return function guardedHandle(channel: string, listener: IpcHandler): void {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!authState.isUnlocked()) {
        return NOT_UNLOCKED_ERROR
      }
      return listener(event, ...args)
    })
  }
}
