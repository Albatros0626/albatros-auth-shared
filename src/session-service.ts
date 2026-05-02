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
/**
 * v1: DPAPI-encrypted envelope (`{ version: 1, ciphertext }`). Could not be
 *     decrypted across apps because Electron's safeStorage uses a Master Key
 *     stored per-app in `userData/Local State`.
 * v2: Plain JSON (`{ version: 2, ...content }`). The session file lives in
 *     `%LOCALAPPDATA%` (per-user) with file permissions restricting access
 *     to the owner. Content is not sensitive (timestamps + opaque token +
 *     appId), so OS-level isolation is sufficient and the cross-app sharing
 *     becomes reliable.
 */
export const SESSION_FILE_VERSION = 2
export const SESSION_FILE_VERSIONS_SUPPORTED: readonly number[] = [2]
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
    activityThrottleMs = DEFAULT_ACTIVITY_THROTTLE_MS,
    watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS,
  } = opts
  // opts.safeStorage is deprecated and intentionally ignored — see CreateSessionServiceOpts.

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
      const parsed = JSON.parse(raw) as { version: number } & Partial<SessionContent>
      if (!SESSION_FILE_VERSIONS_SUPPORTED.includes(parsed.version)) {
        // v1 used DPAPI; can no longer be decrypted reliably across apps.
        // Treat as no session — next unlock will write a fresh v2 file.
        return null
      }
      // v2: plain JSON, fields are at the top level alongside `version`.
      const { version: _v, ...content } = parsed
      return content as SessionContent
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[session] Failed to read session file:', err)
      return null
    }
  }

  function writeContent(content: SessionContent): void {
    ensureDir()
    const payload = { version: SESSION_FILE_VERSION, ...content }
    // Per-writer tmp suffix so concurrent processes don't trip over each other:
    // without this, two workers writing simultaneously share `session.bin.tmp` and
    // the second's rename throws ENOENT after the first has already moved it.
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
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
      let lastSnapshot: string | null = null

      const fireDebounced = (): void => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          try {
            const state = readContent()
            // De-dupe: only invoke the callback when the file content has
            // actually changed since the last snapshot. fs.watch can fire
            // many spurious events (per-pid tmp files, double-events on
            // Windows rename, etc.) — content comparison filters those out.
            const snapshot = state ? JSON.stringify(state) : null
            if (snapshot === lastSnapshot) return
            lastSnapshot = snapshot
            cb(state ? deriveState(state) : null)
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[session] watch callback failed:', err)
          }
        }, watchDebounceMs)
      }

      try {
        ensureDir()
        // Listen to ANY change in the shared dir. Filtering by filename is
        // unreliable on Windows (filename can be null, the tmp name, or
        // session.bin depending on the rename event side). Debounce + content
        // comparison keeps the callback noise-free without missing events.
        watcher = fsWatch(sharedDir, () => fireDebounced())
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
