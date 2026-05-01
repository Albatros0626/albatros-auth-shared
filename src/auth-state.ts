export type UnlockListener = (unlocked: boolean) => void

export interface AuthState {
  isUnlocked(): boolean
  setUnlocked(v: boolean): void
  onUnlockChange(listener: UnlockListener): () => void
}

export function createAuthState(): AuthState {
  let unlocked = false
  const listeners = new Set<UnlockListener>()

  return {
    isUnlocked(): boolean {
      return unlocked
    },

    setUnlocked(v: boolean): void {
      if (unlocked === v) return
      unlocked = v
      for (const listener of listeners) {
        try {
          listener(v)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[auth-state] unlock-change listener threw:', err)
        }
      }
    },

    onUnlockChange(listener: UnlockListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
