# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
