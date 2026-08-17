# @albatros/auth-shared

Shared application-level authentication, secrets vault and cross-app session sync for Albatros desktop apps (Electron).

Used by Prospector V2, Cadence, Candidate Manager and future apps. Unlocking one app unlocks the others; auto-lock and the master password are mutualized; per-app secrets stay separate.

## What's inside

| Module | Purpose |
|---|---|
| `auth-service` | PBKDF2-SHA512 password / recovery question, anti-brute-force lockout, vault format v2 with auto-migration from v1 |
| `secrets-service` | DPAPI-encrypted vault (Windows safeStorage / macOS Keychain / Linux libsecret) with per-app allowlist enforcement |
| `biometric-service` | Optional Windows Hello unlock — a TPM-backed signature decrypts the stored code, which still goes through `verifyCode()` |
| `auth-state` | In-memory unlock flag with `onUnlockChange` event subscriber |
| `guarded-handle` | IPC wrapper that rejects calls with `NOT_UNLOCKED_ERROR` while locked |
| `session-service` | Shared `session.bin` (DPAPI-encrypted) so unlocking one app unlocks the others |
| `activity-tracker` | Generic idle detector (env-agnostic) for the renderer's `useIdleLock` hook |
| `idle-watcher` | Main-side watcher: polls session expiration + listens to cross-app locks |
| `migration` | One-shot legacy-to-shared vault migration helpers |

## Install

```bash
pnpm add github:Albatros0626/albatros-auth-shared#v1.0.0
```

`dist/` is committed to the repo, so consumer apps install zero-config (no `prepare` script, no `onlyBuiltDependencies` allowlist needed).

## Integration example (main process)

```ts
import { app, ipcMain, safeStorage } from 'electron'
import path from 'path'
import {
  createAuthService,
  createSecretsService,
  createAuthState,
  createGuardedHandle,
  createSessionService,
  createIdleWatcher,
  migrateLocalAuthToShared,
  detectMigrationConflict,
} from '@albatros/auth-shared'

const APP_ID = 'prospector'
const sharedDir = path.join(app.getPath('appData'), '..', 'Local', 'AlbatrosApps')
const localVaultPath = path.join(app.getPath('userData'), 'auth.vault')
const sharedVaultPath = path.join(sharedDir, 'auth.vault')

// 1. Migrate legacy per-app vault if needed (one-shot, idempotent)
const migration = migrateLocalAuthToShared({
  localVaultPath,
  sharedVaultPath,
  appId: APP_ID,
  migrationLogPath: path.join(sharedDir, 'migration.log'),
})

if (migration.outcome === 'conflict-needs-resolution') {
  // Surface a UX dialog letting the user pick which vault to keep
}

// 2. Wire the services
const authService = createAuthService({ vaultPath: sharedVaultPath })

const secretsService = createSecretsService({
  vaultPath: path.join(app.getPath('userData'), 'secrets.vault'),
  allowlist: ['ai.apiKey', 'integrations.lusha.apiKey'], // per-app allowlist
  safeStorage,
})

const sessionService = createSessionService({
  sharedDir,
  appId: APP_ID,
  safeStorage,
})

const authState = createAuthState()
const guardedHandle = createGuardedHandle({ ipcMain, authState })

// 3. Listen for cross-app lock/unlock
sessionService.watch((state) => {
  if (state && state.isValid && !authState.isUnlocked()) {
    // Another app unlocked → adopt the unlock
    authState.setUnlocked(true)
  } else if (state && !state.isValid && authState.isUnlocked()) {
    // Another app locked, or session expired → lock locally too
    authState.setUnlocked(false)
  }
})

// 4. Auto-lock by inactivity (main-side watcher)
let idleWatcher: ReturnType<typeof createIdleWatcher> | null = null

authState.onUnlockChange((unlocked) => {
  if (unlocked) {
    idleWatcher = createIdleWatcher({
      sessionService,
      onLock: () => {
        sessionService.recordLock()
        authState.setUnlocked(false)
      },
    })
    idleWatcher.start()
  } else {
    idleWatcher?.stop()
    idleWatcher = null
  }
})

// 5. Wire IPC handlers — auth:* and secrets:has/set/delete are NOT guarded
//    (accessible while locked); everything else uses guardedHandle
ipcMain.handle('auth:verifyCode', async (_e, code: string) => {
  const ok = await authService.verifyCode(code)
  if (ok) {
    sessionService.recordUnlock({
      lockTimeoutMinutes: authService.getLockTimeoutMinutes(),
    })
    authState.setUnlocked(true)
  }
  return { ok, lockoutStatus: authService.getLockoutStatus() }
})

ipcMain.handle('auth:lock', () => {
  sessionService.recordLock()
  authState.setUnlocked(false)
})

ipcMain.handle('auth:recordActivity', () => {
  sessionService.recordActivity()
})

guardedHandle('contacts:getAll', async () => {
  // ... business logic; only reachable when unlocked
})
```

## Integration example (renderer — React hook)

The package does NOT include React. Each app writes a ~15-line hook around `createActivityTracker`:

```tsx
import { useEffect } from 'react'
import { createActivityTracker } from '@albatros/auth-shared'

export function useIdleLock(opts: {
  timeoutMinutes: number
  onLock: () => void
  onActivity?: () => void
}): void {
  useEffect(() => {
    if (!opts.timeoutMinutes) return
    const tracker = createActivityTracker({
      timeoutMs: opts.timeoutMinutes * 60_000,
      onIdle: opts.onLock,
    })
    tracker.start()

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel']
    let lastActivity = 0
    const handler = () => {
      tracker.recordActivity()
      // Throttle the IPC call to once per second
      const now = Date.now()
      if (now - lastActivity > 1000) {
        lastActivity = now
        opts.onActivity?.()
      }
    }
    events.forEach((e) => window.addEventListener(e, handler))

    return () => {
      tracker.stop()
      events.forEach((e) => window.removeEventListener(e, handler))
    }
  }, [opts.timeoutMinutes, opts.onLock, opts.onActivity])
}
```

In the App component:

```tsx
useIdleLock({
  timeoutMinutes: lockTimeoutMinutes,
  onLock: () => window.electronAPI.auth.lock(),
  onActivity: () => window.electronAPI.auth.recordActivity(),
})
```

## Biometric unlock (Windows Hello)

Entirely optional. An app that injects no provider behaves exactly as before —
`isEnrolled()` stays `false`, no button is shown, nothing changes on disk.

**Hello does not replace verification, it restores the factor.** A TPM-backed
signature decrypts the stored code, which then goes through the ordinary
`verifyCode()`. PBKDF2, constant-time comparison and the lockout counter all
still apply, and exactly one code path can declare the app unlocked.

```ts
import { createBiometricService } from '@albatros/auth-shared'
import { createWindowsHelloProvider } from '@albatros/win-hello' // native, Windows only

const biometricService = createBiometricService({
  blobPath: path.join(sharedDir, 'biometric.bin'),
  authService,
  // Omit or pass null on platforms without a provider — every call then
  // reports "unavailable" instead of forcing null checks at each call site.
  provider: process.platform === 'win32' ? createWindowsHelloProvider() : null,
})

// Unlock — NOT guarded, like auth:verifyCode (reachable while locked).
ipcMain.handle('auth:biometricUnlock', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)!
  const result = await biometricService.unlock(win.getNativeWindowHandle())
  if (result.ok) {
    sessionService.recordUnlock({
      lockTimeoutMinutes: authService.getLockTimeoutMinutes(),
    })
    authState.setUnlocked(true)
  }
  return result
})

// Settings — enrolment requires the code the user just typed. GUARDED, like
// every non-auth channel: settings are only reachable unlocked, and an
// unguarded enroll would hand a locked renderer a brute-force oracle —
// enroll() validates through verifyCurrentCode(), which by design neither
// increments failed_attempts nor checks the lockout window.
guardedHandle('auth:biometricEnroll', async (event, code: string) => {
  const win = BrowserWindow.fromWebContents(event.sender)!
  await biometricService.enroll(code, win.getNativeWindowHandle())
})

// GUARDED too: a locked renderer must not be able to revoke the enrolment
// of every Albatros app.
guardedHandle('auth:biometricDisable', () => biometricService.disable())

// Status is needed by the lock screen (to decide whether to show the button),
// so it stays unguarded — it exposes nothing sensitive.
ipcMain.handle('auth:biometricStatus', async () => ({
  supported: await biometricService.isSupported(),
  enrolled: biometricService.isEnrolled(),
}))
```

`auth:biometricUnlock` and `auth:biometricStatus` are the **only** unguarded
biometric channels.

The window handle is resolved **in the main process from the IPC sender**, so
the renderer never deals with an HWND — the button calls
`window.electronAPI.auth.biometricUnlock()` with no arguments.

### Unlock screen

Keep the code field as the primary path and add the Hello button beside it.

- **Gate the button on `isEnrolled()` alone** — a cheap synchronous file check.
  Do not call `isSupported()` on every render: a blob can only exist if
  enrolment succeeded, so its presence already proves Hello worked. If Hello
  disappears later, the call fails with `key-mismatch`, the blob is discarded
  and the button vanishes on its own.
- **Hide it, don't disable it**, when there is no enrolment — enabling happens
  in settings, not here.
- **Show a pending state**: a Hello prompt takes 0.3–5.6s in practice.
- **Leave the code field usable** during the prompt. First path to succeed
  wins; ignore the other's late result. Do not block the field — the user would
  be trapped if Hello never answers.
- **Do not auto-trigger Hello on screen load.** A prompt raised without
  foreground focus is exactly the condition that produces
  `WINBIO_E_INVALID_TICKET`; a click guarantees the focus.

Failure handling:

| `failure` | Suggested treatment |
|---|---|
| `rejected` + `reason: 'cancelled'` | say nothing — the user cancelled on purpose |
| `rejected` + `retries-exhausted` / `device-locked` | "Windows Hello is locked — use your code" |
| `stale` / `key-mismatch` | "Your code changed — re-enable Windows Hello in settings" |
| `code-refused` | show `result.lockoutStatus`, as for a rejected code |
| `not-enrolled` | should not happen: the button was hidden |

### Settings

Three states, and only this screen has to explain itself:

1. **No provider** (no addon, non-Windows) → hide the section entirely.
2. **`isSupported()` false** → show the row disabled, with a shortcut to
   `shell.openExternal('ms-settings:signinoptions-launchfingerprintenrollment')`.
3. **`isSupported()` true** → offer the toggle; enabling asks for the code.

Say **"Windows Hello"**, not "fingerprint": Windows picks the modality (face,
fingerprint or PIN) and no API can require one. A PIN-only Hello is perfectly
valid here — same TPM key, same user verification, only the convenience differs.

Disabling revokes the enrolment **for every Albatros app**, since there is one
shared enrolment. Word the confirmation accordingly.

One enrolment covers every app because Hello keys are not scoped per
executable: a key created by one binary opens from another under the same user
(verified with two differently-named executables). The package-identity
scoping that applies to UWP apps does not affect unpackaged Win32 builds.

### Threat model

What this protects against, and what it does not:

- The private key lives in the TPM, is non-exportable, and is only usable after
  a Hello verification. Copying `biometric.bin` to another machine yields
  nothing.
- **The blob is a plaintext-equivalent of the code** on the machine that holds
  the key. Any process running as the user can read the file *and* raise a Hello
  prompt with the stored challenge — a malware in session that gets the user to
  present a finger obtains the code. This is the same model Bitwarden and
  KeePassXC accept for their Hello unlock.
- Every cleartext field is bound into the AES-GCM tag as additional
  authenticated data, so an attacker with write access cannot forge `boundTo` to
  keep a stale blob alive, nor swap the challenge.
- The blob is **not** additionally wrapped in DPAPI. `safeStorage` derives a
  per-app master key — the reason `session.bin` v1 could not be shared across
  apps (see `session-service.ts`) — and raw DPAPI would not stop a process
  running under the same user account anyway.

## Integrating in a new app

For step-by-step integration in a fresh Electron app, see **[docs/INTEGRATION.md](docs/INTEGRATION.md)** — it includes the auth-context template, IPC handler patterns, renderer hook, migration recipes, and a smoke-test checklist.

## Public API surface

```ts
import {
  // Auth (password + recovery)
  createAuthService,
  validateCode, normalizeAnswer,
  PBKDF2_ITERATIONS, LOCKOUT_THRESHOLD, LOCKOUT_DURATION_MS,
  VAULT_VERSION, SUPPORTED_VAULT_VERSIONS, DEFAULT_LOCK_TIMEOUT_MINUTES,

  // Secrets (DPAPI vault)
  createSecretsService, anonymizeKeyForLog, SECRETS_VAULT_VERSION,

  // Biometric unlock (Windows Hello) — optional
  createBiometricService,
  BIOMETRIC_BLOB_VERSION, SUPPORTED_BIOMETRIC_BLOB_VERSIONS,
  DEFAULT_BIOMETRIC_KEY_NAME,

  // State + IPC guard
  createAuthState, createGuardedHandle, NOT_UNLOCKED_ERROR,

  // Cross-app session
  createSessionService,
  SESSION_FILENAME, SESSION_FILE_VERSION,
  DEFAULT_ACTIVITY_THROTTLE_MS, DEFAULT_WATCH_DEBOUNCE_MS,

  // Auto-lock
  createActivityTracker, createIdleWatcher, DEFAULT_IDLE_POLL_MS,

  // Migration
  migrateLocalAuthToShared, detectMigrationConflict, appendMigrationLog,
  BACKUP_SUFFIX,

  // Recovery question constants
  RECOVERY_QUESTIONS, CUSTOM_QUESTION_MIN_LENGTH, RECOVERY_ANSWER_MIN_LENGTH,

  // Errors
  VaultVersionUnsupportedError, VaultNotInitializedError,
  KeyNotAllowedError, DPAPIUnavailableError,
  SecretsVaultVersionUnsupportedError,
  BiometricUnavailableError, BiometricCodeRejectedError,
  BiometricNonDeterministicError,
} from '@albatros/auth-shared'
```

All the major types (`AuthService`, `SecretsService`, `SessionState`, `LockoutStatus`, `MigrationResult`, etc.) are exported as well.

## Storage layout on the user's machine

| Location | Purpose | Shared between apps? |
|---|---|---|
| `%LOCALAPPDATA%\AlbatrosApps\auth.vault` | Master password + recovery + lock policy | yes |
| `%LOCALAPPDATA%\AlbatrosApps\session.bin` | Current unlock state (DPAPI-encrypted) | yes |
| `%LOCALAPPDATA%\AlbatrosApps\biometric.bin` | Windows Hello enrolment (optional) | yes |
| `%LOCALAPPDATA%\AlbatrosApps\migration.log` | One-shot migration audit (JSONL) | yes |
| `%APPDATA%\<app>\secrets.vault` | App-specific API keys (DPAPI-encrypted) | no |
| `%APPDATA%\<app>\<other app data>` | Database, settings, etc. | no |

## Vault format versioning

Each vault carries a `version` field plus a `schemaCompat` array indicating which versions a reader can handle.

- `auth.vault` v1 → v2 migration is performed lazily by `auth-service` on first read; adds `lockTimeoutMinutes` and `schemaCompat: [1, 2]`.
- Vaults written by a future app version (`version > 2`) trigger `VaultVersionUnsupportedError` so the user can be told to update.

To bump the format breakingly in the future, coordinate the deployment of the three (or more) consumer apps in a wave so no app is left behind.

## Development

```bash
pnpm install
pnpm test              # vitest run (~60s, PBKDF2 dominates)
pnpm test:watch        # vitest watch
pnpm test:coverage     # coverage report
pnpm build             # tsc → dist/
pnpm lint              # tsc --noEmit (full type-check)
pnpm clean             # rimraf dist
pnpm prerelease        # clean + build + test (run before tagging)
```

## Maintainer release workflow

```bash
# 1. Make changes, run tests
pnpm test

# 2. Bump version + update CHANGELOG.md
# (edit package.json version + add a CHANGELOG section)

# 3. Run pre-release (rebuilds dist/ which is committed)
pnpm prerelease

# 4. Commit + tag + push
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

Consumers then bump their dependency to the new tag.

## Versioning

- `v0.x` — work in progress, breaking changes possible
- `v1.x` — first stable; `v1.minor.patch` bumps stay backwards-compatible
- `v2.0.0+` — major bumps require coordinated rollout across all consumer apps

## License

UNLICENSED — internal use only.
