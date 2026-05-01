/**
 * Cross-process worker for the multi-app integration tests.
 *
 * Invocation:
 *   node worker.cjs <sharedDir> <appId> <command> [args...]
 *
 * Commands:
 *   - unlock <lockTimeoutMinutes>   → recordUnlock; prints SessionState
 *   - lock                          → recordLock; prints { ok: true }
 *   - activity                      → recordActivity then __flushPendingForTests; prints { ok: true }
 *   - read                          → read; prints SessionState | null
 *
 * Uses an in-process mock of safeStorage with a stable scheme so multiple
 * worker invocations encrypt/decrypt the same payload identically. This is
 * NOT real DPAPI — it's a deterministic test stub.
 */

const { createSessionService } = require('../../dist')

function makeMockSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`ENC::${plain}`, 'utf-8'),
    decryptString: (buf) => {
      const s = buf.toString('utf-8')
      if (!s.startsWith('ENC::')) throw new Error('Mock: not an encrypted payload')
      return s.slice(5)
    },
  }
}

function main() {
  const [, , sharedDir, appId, command, ...args] = process.argv
  if (!sharedDir || !appId || !command) {
    process.stderr.write('usage: worker.cjs <sharedDir> <appId> <command> [args...]\n')
    process.exit(2)
  }

  const session = createSessionService({
    sharedDir,
    appId,
    safeStorage: makeMockSafeStorage(),
  })

  let result
  switch (command) {
    case 'unlock': {
      const timeout = parseInt(args[0] ?? '10', 10)
      result = session.recordUnlock({ lockTimeoutMinutes: timeout })
      break
    }
    case 'lock':
      session.recordLock()
      result = { ok: true }
      break
    case 'activity':
      session.recordActivity()
      session.__flushPendingForTests()
      result = { ok: true }
      break
    case 'read':
      result = session.read()
      break
    default:
      process.stderr.write(`unknown command: ${command}\n`)
      process.exit(2)
  }

  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

try {
  main()
} catch (err) {
  process.stderr.write(JSON.stringify({ error: err && err.message ? err.message : String(err) }))
  process.exit(1)
}
