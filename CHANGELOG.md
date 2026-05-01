# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
