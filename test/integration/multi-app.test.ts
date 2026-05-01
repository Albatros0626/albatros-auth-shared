/**
 * Multi-process integration tests.
 *
 * Spawns the worker.cjs script as a fresh Node process for each operation,
 * proving that the session.bin file format is the only handoff channel
 * needed for cross-app session sharing. Same-process scenarios are already
 * covered by `src/session-service.test.ts` — these tests focus on the
 * file-as-IPC contract under genuine process isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import path from 'path'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'

const WORKER = path.join(__dirname, 'worker.cjs')

let sharedDir: string
let runId = 0

beforeEach(() => {
  runId += 1
  sharedDir = path.join(tmpdir(), `auth-shared-multi-app-${process.pid}-${Date.now()}-${runId}`)
  mkdirSync(sharedDir, { recursive: true })
})

afterEach(() => {
  try { rmSync(sharedDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

interface WorkerResult {
  unlockerAppId?: string
  lockTimeoutMinutes?: number
  isLocked?: boolean
  isExpired?: boolean
  isValid?: boolean
  unlockedAt?: string
  lastActivityAt?: string
  lockedAt?: string | null
  ok?: boolean
}

function runWorker(appId: string, command: string, ...args: string[]): WorkerResult | null {
  const out = execFileSync(
    'node',
    [WORKER, sharedDir, appId, command, ...args],
    { encoding: 'utf-8' },
  )
  const trimmed = out.trim()
  return trimmed.length === 0 ? null : (JSON.parse(trimmed) as WorkerResult | null)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('multi-process session sync', () => {
  it('app B reads session written by app A from a separate process', () => {
    runWorker('app-a', 'unlock', '10')

    const stateFromB = runWorker('app-b', 'read')
    expect(stateFromB).not.toBeNull()
    expect(stateFromB!.unlockerAppId).toBe('app-a')
    expect(stateFromB!.isValid).toBe(true)
    expect(stateFromB!.lockTimeoutMinutes).toBe(10)
  })

  it('lock recorded by app A is visible to app B (separate processes)', () => {
    runWorker('app-a', 'unlock', '10')
    runWorker('app-a', 'lock')

    const stateFromB = runWorker('app-b', 'read')
    expect(stateFromB).not.toBeNull()
    expect(stateFromB!.isLocked).toBe(true)
    expect(stateFromB!.isValid).toBe(false)
  })

  it('app B observes lastActivityAt update from app A', async () => {
    runWorker('app-a', 'unlock', '10')
    const before = runWorker('app-b', 'read')
    expect(before).not.toBeNull()

    // Ensure timestamps will differ (Date.now() resolution is 1ms but be safe)
    await sleep(50)

    runWorker('app-a', 'activity')
    const after = runWorker('app-b', 'read')
    expect(after).not.toBeNull()
    expect(new Date(after!.lastActivityAt!).getTime())
      .toBeGreaterThan(new Date(before!.lastActivityAt!).getTime())
  })

  it('multiple unlocks from different apps: last writer wins', () => {
    runWorker('app-a', 'unlock', '10')
    runWorker('app-b', 'unlock', '15')

    const state = runWorker('app-c', 'read')
    expect(state).not.toBeNull()
    expect(state!.unlockerAppId).toBe('app-b')
    expect(state!.lockTimeoutMinutes).toBe(15)
  })

  it('read on missing session returns null', () => {
    const state = runWorker('app-x', 'read')
    expect(state).toBeNull()
  })

  it('after lock, app B unlocking again produces a fresh valid session', () => {
    runWorker('app-a', 'unlock', '10')
    runWorker('app-a', 'lock')

    runWorker('app-b', 'unlock', '20')
    const state = runWorker('app-c', 'read')
    expect(state).not.toBeNull()
    expect(state!.isValid).toBe(true)
    expect(state!.unlockerAppId).toBe('app-b')
    expect(state!.lockTimeoutMinutes).toBe(20)
    expect(state!.lockedAt).toBeNull()
  })

  it('session token rotates on each unlock (replay protection)', () => {
    const first = runWorker('app-a', 'unlock', '10') as WorkerResult & { sessionToken?: string }
    const second = runWorker('app-b', 'unlock', '10') as WorkerResult & { sessionToken?: string }
    expect(first.sessionToken).toBeTruthy()
    expect(second.sessionToken).toBeTruthy()
    expect(first.sessionToken).not.toBe(second.sessionToken)
  })

  it('atomic write: tmp file is cleaned up after unlock', () => {
    runWorker('app-a', 'unlock', '10')
    expect(existsSync(path.join(sharedDir, 'session.bin'))).toBe(true)
    expect(existsSync(path.join(sharedDir, 'session.bin.tmp'))).toBe(false)
  })

  it('file format: session.bin is a versioned envelope with base64 ciphertext', () => {
    runWorker('app-a', 'unlock', '10')
    const raw = readFileSync(path.join(sharedDir, 'session.bin'), 'utf-8')
    const envelope = JSON.parse(raw) as { version: number; ciphertext: string }
    expect(envelope.version).toBe(1)
    expect(typeof envelope.ciphertext).toBe('string')
    expect(envelope.ciphertext.length).toBeGreaterThan(0)
    // The mock encrypts with "ENC::" prefix; assert it round-trips through base64
    const decoded = Buffer.from(envelope.ciphertext, 'base64').toString('utf-8')
    expect(decoded.startsWith('ENC::')).toBe(true)
  })

  it('parallel unlocks from independent processes do not corrupt the file', async () => {
    // Spawn 5 workers concurrently. Each writes a session. Only the last write
    // remains, but the file must be parseable at every observation.
    const procs = Array.from({ length: 5 }, (_, i) => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn('node', [WORKER, sharedDir, `app-${i}`, 'unlock', '10'], { stdio: 'ignore' })
        child.on('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`worker app-${i} exited with code ${code}`))
        })
        child.on('error', reject)
      })
    })
    await Promise.all(procs)

    const final = runWorker('reader', 'read')
    expect(final).not.toBeNull()
    expect(final!.isValid).toBe(true)
    // The unlockerAppId must be one of the 5 apps that just wrote
    expect(final!.unlockerAppId).toMatch(/^app-[0-4]$/)
  })
})
