import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  watch as fsWatch,
  type FSWatcher,
} from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import type {
  CreateSessionServiceOpts,
  SafeStorageLike,
  SessionContent,
  SessionFileEnvelope,
  SessionState,
} from './types'

export const SESSION_FILENAME = 'session.bin'
export const SESSION_FILE_VERSION = 1
export const DEFAULT_ACTIVITY_THROTTLE_MS = 10_000
export const DEFAULT_WATCH_DEBOUNCE_MS = 100

export interface SessionService {
  read(): SessionState | null
  recordUnlock(opts: { lockTimeoutMinutes: number }): SessionState
  recordLock(): void
  recordActivity(): void
  watch(cb: (state: SessionState | null) => void): () => void
  /** @internal Flush any pending throttled writes. Test-only. */
  __flushPendingForTests(): void
}

function nowIso(): string {
  return new Date().toISOString()
}

function randomToken(): string {
  return randomBytes(32).toString('hex')
}

function deriveState(content: SessionContent): SessionState {
  const isLocked = content.lockedAt !== null
  const lastActivityMs = new Date(content.lastActivityAt).getTime()
  const timeoutMs = content.lockTimeoutMinutes * 60 * 1000
  const isExpired =
    content.lockTimeoutMinutes > 0 && Date.now() - lastActivityMs > timeoutMs
  return {
    ...content,
    isLocked,
    isExpired,
    isValid: !isLocked && !isExpired,
  }
}

export function createSessionService(opts: CreateSessionServiceOpts): SessionService {
  const {
    sharedDir,
    appId,
    safeStorage,
    activityThrottleMs = DEFAULT_ACTIVITY_THROTTLE_MS,
    watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS,
  } = opts

  const filePath = path.join(sharedDir, SESSION_FILENAME)
  let activityTimer: NodeJS.Timeout | null = null

  function ensureDir(): void {
    if (!existsSync(sharedDir)) {
      mkdirSync(sharedDir, { recursive: true })
    }
  }

  function readContent(): SessionContent | null {
    if (!existsSync(filePath)) return null
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const envelope = JSON.parse(raw) as SessionFileEnvelope
      if (envelope.version !== SESSION_FILE_VERSION) return null
      const cipher = Buffer.from(envelope.ciphertext, 'base64')
      const json = safeStorage.decryptString(cipher)
      return JSON.parse(json) as SessionContent
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[session] Failed to read session file:', err)
      return null
    }
  }

  function writeContent(content: SessionContent): void {
    ensureDir()
    const json = JSON.stringify(content)
    const cipher = safeStorage.encryptString(json)
    const envelope: SessionFileEnvelope = {
      version: SESSION_FILE_VERSION,
      ciphertext: cipher.toString('base64'),
    }
    const tmp = `${filePath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 })
      renameSync(tmp, filePath)
    } catch (err) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  }

  function flushActivity(): void {
    if (activityTimer) {
      clearTimeout(activityTimer)
      activityTimer = null
      const content = readContent()
      if (content) {
        content.lastActivityAt = nowIso()
        writeContent(content)
      }
    }
  }

  return {
    read(): SessionState | null {
      const content = readContent()
      return content ? deriveState(content) : null
    },

    recordUnlock({ lockTimeoutMinutes }: { lockTimeoutMinutes: number }): SessionState {
      const now = nowIso()
      const content: SessionContent = {
        unlockedAt: now,
        lastActivityAt: now,
        lockTimeoutMinutes,
        lockedAt: null,
        unlockerAppId: appId,
        sessionToken: randomToken(),
      }
      writeContent(content)
      return deriveState(content)
    },

    recordLock(): void {
      const content = readContent()
      if (!content) return
      content.lockedAt = nowIso()
      writeContent(content)
    },

    recordActivity(): void {
      // Leading-skip + trailing-write throttle: schedule a single write at the
      // end of the throttle window. Captures bursts of events with one write.
      if (activityTimer) return
      activityTimer = setTimeout(() => {
        activityTimer = null
        const content = readContent()
        if (!content) return
        content.lastActivityAt = nowIso()
        writeContent(content)
      }, activityThrottleMs)
    },

    watch(cb: (state: SessionState | null) => void): () => void {
      let debounceTimer: NodeJS.Timeout | null = null
      let watcher: FSWatcher | null = null

      try {
        ensureDir()
        watcher = fsWatch(sharedDir, (_eventType, filename) => {
          if (filename !== SESSION_FILENAME) return
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            debounceTimer = null
            try {
              const state = readContent()
              cb(state ? deriveState(state) : null)
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('[session] watch callback failed:', err)
            }
          }, watchDebounceMs)
        })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[session] fs.watch failed:', err)
      }

      return () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }
        if (watcher) {
          try { watcher.close() } catch { /* ignore */ }
          watcher = null
        }
      }
    },

    __flushPendingForTests(): void {
      flushActivity()
    },
  }
}
