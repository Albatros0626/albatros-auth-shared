# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.0.1] - 2026-05-05

### Fixed

- **Idle-watcher initial check is now deferred to the next macrotask**
  (defense in depth). When `start()` was called from an unlock handler
  that flipped `authState` BEFORE writing `session.bin`
  (`setUnlocked(true)` then `recordUnlock(...)`), the synchronous
  immediate check inside the new watcher would read stale "locked"
  state and re-fire `onLock`, silently re-locking the app before
  `verifyCode`/`setup`/`recover` could even respond to the renderer.
  Symptom: every guarded IPC handler called by the renderer
  post-unlock rejected with `NotUnlockedError`, blank dashboard,
  empty settings.

  The check is now deferred via `setTimeout(check, 0)`, which lets any
  same-tick post-state writes complete before `session.bin` is read.
  `setInterval` and `sessionService.watch()` are armed up-front, so
  external lock notifications continue to work synchronously.

  Original race fixed in consumer apps as well (Prospector V2 commit
  826d3c2, Cadence 3d980b3, Candidate Manager 55e1f79) by reordering
  `recordUnlock` before `setUnlocked` — the recommended pattern is
  documented in `docs/INTEGRATION.md`. The package-level fix here is
  defense in depth for future consumers that haven't applied the
  reorder.

### Tests

- 1 new test `deferred initial check tolerates same-tick session.bin
  updates` reproduces the unlock race and asserts the deferred check
  reads the fresh state.
- 2 existing tests that asserted the immediate check was synchronous
  are now `async` and `await new Promise((r) => setTimeout(r, 0))`
  before asserting the spy was called.

### Documentation

- `docs/INTEGRATION.md` updated with explicit ordering rules for
  `recordUnlock` and `setUnlocked` in unlock handlers, with a comment
  block explaining the race in inline code.

## [2.0.0] - 2026-05-04

### BREAKING CHANGE

`createGuardedHandle` now **throws** a `NotUnlockedError` exception when the
app is locked, instead of *returning* the `NOT_UNLOCKED_ERROR` envelope.

#### Why

The v1.x behavior caused silent data corruption in renderer stores: a fetch
that raced a lock would resolve with the error envelope, the store's
`try/catch` would not trigger (the promise never rejected), and the bad
shape would be persisted as if it were the actual data — crashing the next
render with `"X is not iterable"` / `".filter is not a function"` errors.

Throwing aligns with the standard JS / Electron IPC convention (`fetch`
rejects on error, an `ipcMain.handle` listener that throws produces a
rejected promise on the renderer side). Existing `try/catch` blocks
around IPC calls now work as expected without per-store shape checks.

#### Migration

See [docs/MIGRATION_v1_to_v2.md](docs/MIGRATION_v1_to_v2.md) for a step-by-step
guide. Short version:

```ts
// AVANT (v1.x)
const result = await window.electronAPI.getContacts()
if (isGuardedError(result)) { /* handle */ return }
// use result

// APRÈS (v2.0.0)
import { isNotUnlockedError } from '@albatros/auth-shared/browser'
try {
  const result = await window.electronAPI.getContacts()
  // use result — guaranteed to be the real payload
} catch (err) {
  if (isNotUnlockedError(err)) return  // silent grace
  throw err
}
```

`NOT_UNLOCKED_ERROR` and `isGuardedError` remain exported for back-compat
(marked `@deprecated`) — code that still references them keeps compiling.

### Added

- **`NotUnlockedError`** class (extends `Error`) — thrown by
  `createGuardedHandle` instead of returning. Has `name = 'NotUnlockedError'`
  (preserved across Electron IPC) and `code = 'NOT_UNLOCKED'`.
- **`isNotUnlockedError(err)`** type guard exposed from both `/browser` and
  the main entry. Recognizes both real `NotUnlockedError` instances and
  the deserialized version received by the renderer (where `instanceof`
  no longer works because Electron loses the prototype chain).

### Tests

- `guarded-handle.test.ts` (8 → 9 tests) — adapted 3 cases from
  `equals(NOT_UNLOCKED_ERROR)` to `rejects.toThrow(NotUnlockedError)` +
  added a new test asserting `name` and `code` are preserved.
- `guarded-error-types.test.ts` (8 → 12 tests) — 4 new cases for
  `isNotUnlockedError`.

### Audit cross-app (T0 du PLAN_v2.0.0)

Avant la release, audit sur Prospector V2 / Cadence / Candidate Manager :
0 occurrence de `result.success === false` ou de lecture de
`result.error.code` côté renderer. Aucun consommateur ne dépendait du
shape de retour — la breaking change a un impact réel nul.

## [1.2.0] - 2026-05-04

Production hardening pass after the Prospector V2 / Cadence / Candidate
Manager rollout. No breaking changes — apps continue to work without code
changes; the new APIs let them simplify and harden their integrations.

### Added

- **Sleep-aware idle-watcher**. `createIdleWatcher` now detects when the
  host machine has slept (gap between two consecutive ticks larger than
  `pollMs * sleepDetectionMultiplier`, default `3`) and grants a fresh
  idle window via `sessionService.recordActivity()` instead of locking
  immediately on resume. Configurable via the new
  `sleepDetectionMultiplier` option; pass `Infinity` for legacy
  lock-on-wake behavior.
- **`attachActivityTracking()` helper** in `@albatros/auth-shared/browser`
  — bundles `createActivityTracker` + window listener wiring + IPC
  throttle into a single dispose-returning call. Decoupled from React
  and from DOM types (uses a structural `ActivityEventTarget`).
- **`useIdleLock` React hook** in the new `@albatros/auth-shared/react`
  subpath. Stabilizes inline arrow callbacks via `useRef` so the effect
  only re-runs when `timeoutMinutes` changes — eliminates the foot-gun
  where parent re-renders silently reset the idle timer or detach
  listeners. Supersedes the per-app local `useIdleLock` copies.
- **`isGuardedError(x)` type guard** in
  `@albatros/auth-shared/browser` (and re-exported from the main
  entry). Lets renderer stores detect a `NOT_UNLOCKED` envelope without
  a hand-written `Array.isArray` check, until v2.0.0 switches the API
  to throw.

### Changed

- `package.json` exports gain `./react` subpath. `react` added to
  `peerDependencies` as **optional** — only consumers of the React hook
  need it installed.
- `tsconfig.json` `lib` now includes `DOM` (needed for the activity
  helper and the React hook). Existing main-process code is unaffected.

### Tests

- 15 new tests: 4 sleep-detection (idle-watcher), 9
  `attachActivityTracking`, 6 `useIdleLock`, 8 `isGuardedError`. Total
  253 (previously 238).

### Migration notes

No action required to upgrade. To benefit from the new APIs:

- Replace the per-app `useIdleLock.ts` with
  `import { useIdleLock } from '@albatros/auth-shared/react'`.
- In stores that hit guarded IPC, wrap the result with
  `isGuardedError(result)` instead of bespoke shape checks.

See [docs/PLAN_v1.2.0.md](docs/PLAN_v1.2.0.md) for the full task list and
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for the bug reports
that motivated this release.

## [1.1.4] - 2026-05-02

### Added
- `sessionService.updateLockTimeoutMinutes(minutes)`: rewrites the active
  session's `lockTimeoutMinutes` in place (without touching `unlockedAt`,
  `sessionToken`, etc.). Returns true if the file was rewritten, false if
  no session existed or the value was unchanged.
  Use case: when a user changes the auto-lock period in Settings, the
  consuming app's IPC handler can call both `authService.setLockTimeoutMinutes`
  (persists to `auth.vault`) AND `sessionService.updateLockTimeoutMinutes`
  (propagates the change to all running apps via the watched session.bin
  without waiting for the next unlock).

### Tests
- 5 new tests covering the new method (rewrite, preservation of token +
  timestamps, no-op when no session, no-op when unchanged, cross-instance
  propagation). 233 tests pass.

## [1.1.3] - 2026-05-02

### Fixed (critical)
- `session.bin` is no longer DPAPI-encrypted. Each Electron app's `safeStorage`
  uses a Master Key stored in its own `userData/Local State` — this means
  app A could not decrypt a session.bin written by app B, defeating the whole
  point of cross-app session sharing. Symptom: an app starting after another
  Albatros app already unlocked stayed on LockPage; a `lock` from one app did
  not propagate either.

  Fix: `session.bin` is now a plain-JSON document with `{ version: 2, ...content }`
  at the top level. The file lives in `%LOCALAPPDATA%` (per-user, restricted
  by file permissions) and contains only non-sensitive data: ISO timestamps,
  the lock-timeout setting, the unlocker app's id, and an opaque random
  session token. The actual user credentials remain in `auth.vault` (PBKDF2
  hashes, not reversible without brute-forcing the password).

### Changed
- Format: `session.bin` v1 (DPAPI envelope) → v2 (plain JSON). Reading a v1
  file returns `null` and a fresh v2 file is written on the next unlock —
  no user-visible disruption since session files are short-lived.
- API: `CreateSessionServiceOpts.safeStorage` is now optional and ignored
  (deprecated but accepted for backwards compat). Existing consumers that
  pass it continue to work without changes.

### Tests
- 228 tests pass (1 retired: "does not store payload as plaintext" no longer
  applies). Tests that tampered with the v1 ciphertext to provoke
  expiration/etc. now operate directly on the plain-JSON file. The integration
  test that verified the file format was updated to assert v2 plain JSON.

## [1.1.2] - 2026-05-01

### Fixed
- `sessionService.watch()` could miss cross-app session updates on Windows.
  The previous implementation filtered events by `filename === 'session.bin'`,
  but `fs.watch` on Windows is unreliable for filename reporting:
  - filename can be `null`
  - the rename event may report the source filename (the random tmp suffix
    introduced in v1.1.1) rather than the destination
  - Windows can fire double events on rename
  Together this meant Cadence/Candidate Manager could stay locked even after
  Prospector wrote the session — symptom: "another app shows LockPage while
  the unlocker shows the dashboard".

  Fix: the watch now listens to ANY change in the shared dir, debounces, and
  de-dupes by content snapshot before invoking the callback. Spurious tmp
  events get absorbed by the debounce + content comparison; real session
  changes always propagate.

### Tests
- All 229 tests still pass with the looser filter — the existing watch
  tests (debounce, single callback per burst, propagation between
  instances) cover the new behaviour without changes.

## [1.1.1] - 2026-05-01

### Fixed
- Concurrent writes from multiple processes to the same vault file no longer
  race on a shared `.tmp` filename. The CI test
  `parallel unlocks from independent processes do not corrupt the file` was
  failing on Linux because two workers' `renameSync` would target the same
  `<vault>.tmp`, and the second to run threw ENOENT after the first had
  already moved it.

  Fix: each writer now uses a unique tmp suffix
  `<vault>.<pid>.<timestamp>.<random>.tmp`. Cleanup logic still removes the
  exact tmp on failure (the random suffix is captured in a local variable).
  Applied to:
  - `session-service.ts` (writeContent)
  - `secrets-service.ts` (writeVault)
  - `migration.ts` (migrateLocalAuthToShared)

### Tests
- Tests that asserted on the exact `.tmp` filename now glob `*.tmp` in the
  parent dir to match the new naming. Same coverage, race-resistant.

## [1.1.0] - 2026-05-01

US12 — Cross-process integration tests. Phase 4 complete.

### Added
- `test/integration/multi-app.test.ts` — 10 tests that spawn the package
  as a fresh Node process via `child_process.execFileSync` to validate
  the file-based session handoff under genuine process isolation.
- `test/integration/worker.cjs` — small CJS worker invoked by the tests:
  takes a command on argv (`unlock`, `lock`, `activity`, `read`),
  performs it on a real `sessionService` instance, prints the result.

### Scenarios covered (cross-process)
- App B reads session written by app A
- Lock by app A is visible to app B
- App B observes `lastActivityAt` update from app A
- Multiple unlocks: last writer wins, `unlockerAppId` reflects who wrote last
- Read on missing session returns null
- Re-unlock after lock produces a fresh valid session
- Session token rotates on each unlock (replay protection)
- Atomic write cleans up `.tmp` after success
- File format: versioned envelope with base64 ciphertext, parseable
- 5 concurrent unlock workers do not corrupt the file (last-write-wins)

### Verified
- 229 tests total (219 from earlier US + 10 new), all passing
- Same-process scenarios stay covered by `src/session-service.test.ts`;
  the new tests focus on the file-as-IPC contract that consumer apps rely on
- Phase 4 of the auth-shared plan is complete: package, distribution, and
  adoption in Prospector + Cadence + Candidate Manager are all done

## [1.0.1] - 2026-05-01

### Fixed
- Renderer-process consumers (Electron renderer / browser) crashed when
  importing from `@albatros/auth-shared` because the main entry transitively
  pulls in `crypto`/`fs`/`electron` via `auth-service.ts` and
  `secrets-service.ts`. Vite/esbuild cannot resolve those Node modules in a
  browser bundle.

### Added
- New subpath export `@albatros/auth-shared/browser` with only the
  browser-safe primitives:
  - `createActivityTracker` and its types (`ActivityTracker`, `CreateActivityTrackerOpts`)
  - Recovery questions constants (`RECOVERY_QUESTIONS`, `CUSTOM_QUESTION_MIN_LENGTH`, `RECOVERY_ANSWER_MIN_LENGTH`)
  - `LockoutStatus` type re-export
- Renderer code should import from `@albatros/auth-shared/browser`; main process keeps using the default `@albatros/auth-shared`.

## [1.0.0] - 2026-05-01

US8 — First stable release.

### Added
- Comprehensive README with integration examples for main process and renderer hook
- GitHub Actions CI workflow (`.github/workflows/test.yml`):
  - Runs lint + tests on Ubuntu + Windows on every push/PR
  - Verifies `dist/` is in sync with `src/` (catches missing `pnpm prerelease` before commit)
- Maintainer release workflow documented in README

### Stability commitment
This is the first stable release. From v1.0.0 onward:
- v1.minor.patch bumps remain backwards-compatible.
- Breaking changes are reserved for v2.0.0+ and require coordinated rollout across all consumer apps.
- The vault format `schemaCompat` field provides forward-compat reads for non-breaking minor changes.

No code changes vs v0.7.0 — same surface, same behaviour, same 219 tests, 98.35% statements / 95.22% branches coverage.

Consumer apps may now adopt: `pnpm add github:Albatros0626/albatros-auth-shared#v1.0.0`.

## [0.7.0] - 2026-05-01

US7 — Legacy → shared migration. Phase 2 complete.

### Added
- `migrateLocalAuthToShared({ localVaultPath, sharedVaultPath, appId, migrationLogPath? })` returns one of:
  - `no-op-fresh-install` — neither vault exists
  - `no-op-already-migrated` — shared exists, local missing
  - `migrated` — local copied to shared, original renamed to `${localPath}.migrated.bak`
  - `conflict-needs-resolution` — both exist; caller surfaces UX
  - `error` — local file unreadable or atomic write failed; nothing destroyed
- `detectMigrationConflict({ localVaultPath, sharedVaultPath })` — pure boolean check for the conflict scenario
- `appendMigrationLog(logPath, entry)` — appends a JSONL entry; creates parent dirs if needed; logging failure is non-fatal
- `BACKUP_SUFFIX` exported (`.migrated.bak`)

### Design notes
- Atomic write to shared (`.tmp + rename`); on failure, no shared file is left.
- Local backup happens AFTER shared write succeeds. If backup rename fails, returns `error` with message — next run sees both files and triggers `conflict-needs-resolution` for user-driven resolution. No data is ever lost.
- Vault format conversion (v1 → v2 with `lockTimeoutMinutes`) is delegated to `auth-service` on first read of the shared vault. Migration module is only concerned with file location, not content shape.

### Tests
- 23 migration tests covering: detection (4), outcomes (9), error paths (3), logging (5), multi-app scenarios (2)
- migration.ts coverage: 95.14% statements, 96.42% branches
- Total package: 219 tests, 98.35% statements / 95.22% branches

### Phase 2 wrap-up
The package now ships everything needed for cross-app session sharing:
- Shared session file with DPAPI encryption + atomic write (US5)
- Idle detection primitives — env-agnostic activity tracker + main-side watcher (US6)
- Migration helpers for legacy → shared (US7)
- Plus the Phase 1 core: auth-service, secrets-service, auth-state, guarded-handle.

Next: Phase 3 — pre-release prep (US8) before consumer apps adopt.

## [0.6.0] - 2026-05-01

US6 — Auto-lock primitives.

### Added
- `createActivityTracker({ timeoutMs, onIdle })` — env-agnostic idle detector:
  - call `recordActivity()` on every user input to reset the timer
  - fires `onIdle()` once after `timeoutMs` of inactivity
  - `start()` / `stop()` for lifecycle control; `timeoutMs: 0` disables idle detection
  - usable in main process or renderer (consumers wire DOM listeners themselves)
- `createIdleWatcher({ sessionService, onLock, pollMs? })` — main-process watcher:
  - polls `sessionService.read()` (default every 5s) to detect time-based expiration
  - listens to `sessionService.watch()` for instant cross-app lock notifications
  - fires `onLock()` once per `start()` cycle (re-arm after a fresh unlock)
  - immediate check at start handles already-expired sessions
- Both isolate listener errors (caught + logged, no crash).

### Design notes
- No React peer dependency. Each app writes a ~15-line React hook around `createActivityTracker` (mounts DOM listeners in `useEffect`, calls `recordActivity` on each). Keeps the package framework-free.
- `IdleWatcher` does NOT track activity itself — that's the renderer's job via `sessionService.recordActivity()` over IPC. The watcher only reacts to expiration / external locks.

### Tests
- 9 activity-tracker tests + 11 idle-watcher tests
- 100% line/statement/function coverage on both files
- Total: 196 tests, 98.97% statements / 95.08% branches across the package

## [0.5.0] - 2026-05-01

US5 — Session sync between apps (Phase 2 begins).

### Added
- `createSessionService({ sharedDir, appId, safeStorage })` factory:
  - `read()` — returns `SessionState` (raw content + derived `isLocked`/`isExpired`/`isValid`) or `null`
  - `recordUnlock({ lockTimeoutMinutes })` — fresh session token + appId stamped, atomic write
  - `recordLock()` — sets `lockedAt`, no-op if no session exists
  - `recordActivity()` — leading-skip + trailing-write throttle (default 10s, override via `activityThrottleMs`)
  - `watch(cb)` — `fs.watch` with debounce (default 100ms, override via `watchDebounceMs`); returns unsubscribe
- File on disk (`session.bin` in `sharedDir`):
  - JSON envelope `{ version: 1, ciphertext: base64 }` (forward-compat with version field)
  - Payload (DPAPI-encrypted): `unlockedAt`, `lastActivityAt`, `lockTimeoutMinutes`, `lockedAt`, `unlockerAppId`, `sessionToken` (32B hex)
- Atomic write via `.tmp + rename`; tmp cleanup on encrypt failure preserves existing session
- `mkdirSync({ recursive: true })` on first write — sharedDir created automatically
- `read()` returns `null` (rather than throwing) on: missing file, corrupted JSON, unsupported version, DPAPI decrypt failure
- `watch()` is robust to `ensureDir`/`fs.watch` failures: returns a working unsubscribe even if the watcher couldn't start (logs the error)

### Tests
- 33 session-service tests covering: unlock/lock/activity, file format, expiration logic, atomic write, multi-instance shared state, fs.watch debounce, watcher cleanup
- Mock SafeStorage (no Electron coupling)
- Coverage: session-service.ts 97.04% / 91.11% branches (above 90% target)
- Total package coverage: 98.81% statements, 95.65% branches across 176 tests

## [0.4.0] - 2026-05-01

US4 — Auth state + guarded IPC handle ported.

### Added
- `createAuthState()` factory:
  - `isUnlocked()`, `setUnlocked(v)`
  - `onUnlockChange(listener)` — subscribe to unlock/lock transitions; returns an unsubscribe function
  - listener errors are caught and logged so one bad listener does not break others
  - state is per-instance (two `createAuthState()` calls produce isolated states)
- `createGuardedHandle({ ipcMain, authState })` factory:
  - returns a `guardedHandle(channel, listener)` function
  - rejects calls when locked with `NOT_UNLOCKED_ERROR` (`{ success: false, error: { code: 'NOT_UNLOCKED', message: ... } }`)
  - `ipcMain` is dependency-injected (interface `IpcMainLike`) — no Electron coupling, easy to mock
  - re-locking between registration and invocation is checked at call time (correct guard)
- Exported types: `AuthState`, `UnlockListener`, `GuardedHandle`, `GuardedError`, `IpcMainLike`, `IpcHandler`, `CreateGuardedHandleOpts`
- Exported constant: `NOT_UNLOCKED_ERROR`

### Tests
- 9 auth-state tests (initial state, transitions, no-op when unchanged, multi-listener, unsubscribe, throwing listener isolation, multi-instance independence)
- 8 guarded-handle tests (registration, locked rejection, unlocked forwarding, async results, listener throw, lock-after-register, multi-channel)
- 100% coverage on both new files
- Total package coverage: 99.27% statements, 96.91% branches

## [0.3.0] - 2026-05-01

US3 — Secrets service ported.

### Added
- `createSecretsService({ vaultPath, allowlist, safeStorage })` factory:
  - dependency-injected `safeStorage` (any object matching `SafeStorageLike` interface) — keeps the package decoupled from Electron at the type level
  - per-app `allowlist` enforced strictly (`KeyNotAllowedError` on violation)
  - vault path is per-app (secrets stay separate per app, only `auth.vault` is shared)
- API: `setSecret`, `getSecret`, `hasSecret`, `deleteSecret`, `isAvailable`
- Atomic write (`.tmp + rename`) preserves vault integrity on crash
- `anonymizeKeyForLog` exported (logs anonymize keys: `ai.apiKey` → `ai.***`)
- New typed errors: `KeyNotAllowedError`, `DPAPIUnavailableError`, `SecretsVaultVersionUnsupportedError`

### Tests
- 40 secrets-service tests covering allowlist, round-trip, hasSecret/deleteSecret, DPAPI unavailability, vault format, multi-instance, atomic write
- Mock `SafeStorageLike` (no Electron dependency in test environment)
- Coverage: 99.18% statements, 96.59% branches across all files (secrets-service: 96.06% / 93.33%)

## [0.2.0] - 2026-05-01

US2 — Auth service ported.

### Added
- `createAuthService({ vaultPath })` factory exposing the full auth API:
  - `setup`, `verifyCode`, `verifyCurrentCode`
  - `recover`, `testRecovery`, `changeCode`, `changeRecovery`
  - `getRecoveryQuestion`, `getLastCodeChangeDate`, `getLockoutStatus`
  - `getLockTimeoutMinutes`, `setLockTimeoutMinutes`
  - `isSetupComplete`
- Vault format **v2** with `schemaCompat: [1, 2]` and `lockTimeoutMinutes` (default 10).
- Auto-migration from vault v1 → v2 on first read (idempotent, preserves existing data).
- Public utilities: `validateCode`, `normalizeAnswer`.
- Public constants: `PBKDF2_ITERATIONS`, `LOCKOUT_THRESHOLD`, `LOCKOUT_DURATION_MS`, `DEFAULT_LOCK_TIMEOUT_MINUTES`, `SUPPORTED_VAULT_VERSIONS`, etc.
- Recovery question constants: `RECOVERY_QUESTIONS`, `CUSTOM_QUESTION_MIN_LENGTH`, `RECOVERY_ANSWER_MIN_LENGTH`.
- Typed errors: `VaultVersionUnsupportedError`, `VaultNotInitializedError`.

### Tests
- 81 auth-service tests covering setup, verify, recover, lockout, migration v1 → v2, multi-instance.
- 100% line/statement/function coverage, 97.29% branch coverage.

## [0.1.0] - 2026-05-01

Initial bootstrap release (US1).
