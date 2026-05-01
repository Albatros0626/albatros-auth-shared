# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
