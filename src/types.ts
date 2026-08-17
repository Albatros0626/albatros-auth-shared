export interface LockoutStatus {
  locked_until: string | null
  attempts_remaining: number
  required_delay_seconds: number
}

export interface AuthVault {
  version: number
  schemaCompat: number[]
  created_at: string
  last_code_change: string
  pbkdf2_iterations: number
  salt_code: string
  hash_code: string
  salt_recovery: string
  recovery_question: string
  hash_recovery: string
  failed_attempts: number
  lockout_until: string | null
  lockTimeoutMinutes: number
}

export interface SetupOpts {
  code: string
  recoveryQuestion: string
  recoveryAnswer: string
}

export interface CreateAuthServiceOpts {
  vaultPath: string
}

export class VaultVersionUnsupportedError extends Error {
  readonly code = 'VAULT_VERSION_UNSUPPORTED'
  readonly vaultVersion: number
  readonly supportedVersions: readonly number[]

  constructor(vaultVersion: number, supportedVersions: readonly number[]) {
    super(
      `Auth vault version ${vaultVersion} is not supported by this build. ` +
      `Supported versions: ${supportedVersions.join(', ')}. ` +
      `The app may need updating.`,
    )
    this.name = 'VaultVersionUnsupportedError'
    this.vaultVersion = vaultVersion
    this.supportedVersions = supportedVersions
  }
}

export class VaultNotInitializedError extends Error {
  readonly code = 'VAULT_NOT_INITIALIZED'
  constructor() {
    super('Vault not initialized')
    this.name = 'VaultNotInitializedError'
  }
}

/**
 * Thrown by every secret-checking method while the lockout window is open.
 *
 * The message is unchanged from the ad-hoc `Error` that `recover()` threw
 * before v3.0.0, so UIs matching on it keep working; the typed class simply
 * lets callers branch without string comparison.
 */
export class VaultLockedOutError extends Error {
  readonly code = 'VAULT_LOCKED_OUT'
  constructor() {
    super('Application verrouillée, réessayez plus tard')
    this.name = 'VaultLockedOutError'
  }
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface SecretsVault {
  version: number
  secrets: Record<string, string>
}

export interface CreateSecretsServiceOpts {
  vaultPath: string
  allowlist: readonly string[]
  safeStorage: SafeStorageLike
}

export class KeyNotAllowedError extends Error {
  readonly code = 'KEY_NOT_ALLOWED'
  readonly key: string
  constructor(key: string) {
    super(`Secret key not in allowlist: ${key}`)
    this.name = 'KeyNotAllowedError'
    this.key = key
  }
}

export class DPAPIUnavailableError extends Error {
  readonly code = 'DPAPI_UNAVAILABLE'
  constructor() {
    super('Secret storage unavailable (safeStorage not ready)')
    this.name = 'DPAPIUnavailableError'
  }
}

export class SecretsVaultVersionUnsupportedError extends Error {
  readonly code = 'SECRETS_VAULT_VERSION_UNSUPPORTED'
  readonly vaultVersion: number
  constructor(vaultVersion: number) {
    super(`Secrets vault version ${vaultVersion} is not supported.`)
    this.name = 'SecretsVaultVersionUnsupportedError'
    this.vaultVersion = vaultVersion
  }
}

// =============================================================================
// Biometric unlock (Windows Hello)
// =============================================================================

/**
 * Minimal platform surface the biometric service needs. Implemented on Windows
 * by a Node-API addon over `Windows.Security.Credentials.KeyCredentialManager`,
 * and by a fake in tests — the same injection pattern as `SafeStorageLike`.
 *
 * Implementation notes for the native provider, measured on an Entra-joined
 * Windows 11 laptop (2026-08-17):
 *
 * - `sign()` MUST be deterministic: signing the same challenge twice with the
 *   same key returns byte-identical output (verified over 5 consecutive
 *   signatures; RSA-2048, 256 bytes). The envelope depends on it — and
 *   `enroll()` re-verifies it at runtime rather than trusting this note.
 * - `createKey()` and `sign()` show a Hello prompt, so they need a foreground
 *   window. From a background process they fail with `WINBIO_E_INVALID_TICKET`
 *   (0x80098044) — a known unfixed Windows bug that mostly bites facial
 *   recognition (measured: 3 failures out of 5 with face, 0 out of 6 with
 *   fingerprint in the foreground). The provider should call
 *   `AllowSetForegroundWindow`/`SetForegroundWindow` before each call and retry
 *   once or twice on that HRESULT.
 * - Every method MUST be non-blocking (N-API async work). Besides freezing
 *   Electron's main process for up to 5.6s (measured worst case), a blocking
 *   wait on an STA thread *deadlocks*: it starves the very message pump the
 *   Hello dialog needs, so the prompt never paints and the call hangs
 *   indefinitely. Reproduced while probing, and fixed by doing the WinRT work
 *   off the calling thread.
 * - Hello keys are NOT scoped per executable. A key created by one .exe is
 *   opened successfully by another under the same user (verified 2026-08-17
 *   with two differently-named binaries) — the package-identity scoping that
 *   applies to UWP apps does not affect unpackaged Win32 executables. This is
 *   what makes one shared enrolment work across all Albatros apps.
 * - Windows chooses the modality (face / fingerprint / PIN); there is no API to
 *   require one. Callers must say "Windows Hello", not "fingerprint".
 * - Windows briefly caches the biometric ticket, so two signatures in quick
 *   succession may only prompt once. Never treat a successful `sign()` as proof
 *   of a fresh user gesture.
 */
export interface BiometricProviderLike {
  /** True when the platform has Hello configured and usable. */
  isAvailable(): Promise<boolean>
  /** Creates (replacing any existing) the Hello-protected key pair. Prompts. */
  createKey(keyName: string, hwnd: Buffer): Promise<void>
  /** Signs `challenge` with the Hello-protected private key. Prompts. */
  sign(keyName: string, challenge: Buffer, hwnd: Buffer): Promise<Buffer>
  /** Removes the key pair. Best effort — must not throw if already gone. */
  deleteKey(keyName: string): Promise<void>
}

/**
 * Why the platform refused a Hello operation. The native provider maps
 * HRESULTs to these; TypeScript never sees an HRESULT.
 *
 * Surfaced so the UI can stay quiet on a deliberate `cancelled` but say
 * something useful on `device-locked` — the two need opposite treatment.
 */
export const BIOMETRIC_REJECTION_REASONS = [
  'cancelled',
  'retries-exhausted',
  'device-locked',
  'not-found',
] as const

export type BiometricRejectionReason =
  | (typeof BIOMETRIC_REJECTION_REASONS)[number]
  | 'unknown'

/**
 * On-disk envelope holding the app code, encrypted under a key derived from a
 * Hello signature. Deliberately kept OUT of `AuthVault`: bumping the vault
 * version would make older Albatros apps throw `VaultVersionUnsupportedError`
 * on the shared vault, whereas an unknown extra file is simply ignored.
 *
 * Machine-bound — the private key lives in the TPM and never leaves it — so
 * this must never be written to a roamed or synced location.
 *
 * Every plaintext field below is authenticated as AES-GCM additional data (see
 * `buildAad` in `biometric-service.ts`). Without that, the GCM tag would only
 * cover the ciphertext and an attacker with write access could forge `boundTo`
 * to keep a stale blob "fresh", or swap the challenge.
 */
export interface BiometricBlob {
  version: number
  /** Name of the Hello key pair backing this blob. */
  keyName: string
  /** Fixed challenge signed to derive the KEK. base64. */
  challenge: string
  /** HKDF salt. base64. */
  salt: string
  /** AES-256-GCM nonce. base64. */
  iv: string
  /** The app code, encrypted. base64. */
  ciphertext: string
  /** AES-256-GCM authentication tag. base64. */
  authTag: string
  /**
   * `AuthVault.last_code_change` at enrolment time. If the vault's value has
   * moved on, the stored code is stale and the blob MUST be discarded —
   * otherwise every biometric unlock feeds a wrong code to `verifyCode()` and
   * locks the user out after five attempts.
   */
  boundTo: string
  createdAt: string
}

/**
 * The slice of `AuthService` the biometric service depends on. Narrowing it
 * keeps the two modules decoupled and lets tests run against a fake without
 * paying 600k PBKDF2 iterations per case. `AuthService` satisfies it
 * structurally.
 */
export interface BiometricAuthServiceLike {
  verifyCode(code: string): Promise<boolean>
  verifyCurrentCode(code: string): Promise<boolean>
  getLastCodeChangeDate(): string | null
  getLockoutStatus(): LockoutStatus
}

export interface CreateBiometricServiceOpts {
  /**
   * Path to the biometric blob. Must be machine-local (`%LOCALAPPDATA%`),
   * never a roamed or synced location — the blob is TPM-bound.
   */
  blobPath: string
  /**
   * Optional on purpose: apps pass `null`/omit on platforms without a native
   * provider. Everything then reports "unavailable" instead of forcing every
   * call site into null checks.
   */
  provider?: BiometricProviderLike | null
  /** Used to validate the code at enrolment and to verify it at unlock. */
  authService: BiometricAuthServiceLike
  /** Hello key pair name. Defaults to `DEFAULT_BIOMETRIC_KEY_NAME`. */
  keyName?: string
}

/** Why a biometric unlock did not produce an unlocked session. */
export type BiometricUnlockFailure =
  /** No usable blob on disk (absent, corrupt, or written by a newer app). */
  | 'not-enrolled'
  /** The code changed since enrolment; the blob was discarded. */
  | 'stale'
  /** The Hello key is gone or the blob was tampered with; blob discarded. */
  | 'key-mismatch'
  /** Hello itself refused — see `reason`. The blob is kept. */
  | 'rejected'
  /** The vault refused the restored code (lockout, or a concurrent change). */
  | 'code-refused'

export interface BiometricUnlockResult {
  ok: boolean
  /** Present only when `ok` is false. */
  failure?: BiometricUnlockFailure
  /**
   * Refines `rejected` so the UI can stay silent on a deliberate cancel.
   * Also set to `not-found` on `key-mismatch` when the Hello key pair no
   * longer exists (NGC/TPM reset) and the enrolment was discarded.
   */
  reason?: BiometricRejectionReason
  /** Lockout state when `failure` is `code-refused`, for direct display. */
  lockoutStatus?: LockoutStatus
}

export class BiometricUnavailableError extends Error {
  readonly code = 'BIOMETRIC_UNAVAILABLE'
  constructor(message = 'Windows Hello indisponible sur ce poste') {
    super(message)
    this.name = 'BiometricUnavailableError'
  }
}

export class BiometricCodeRejectedError extends Error {
  readonly code = 'BIOMETRIC_CODE_REJECTED'
  constructor() {
    super('Code incorrect — enrôlement biométrique refusé')
    this.name = 'BiometricCodeRejectedError'
  }
}

/**
 * Raised when the platform's Hello key does not sign deterministically, which
 * makes the whole envelope unusable. Determinism was measured on one machine;
 * another TPM could sign with a randomised scheme (RSA-PSS), and without this
 * check enrolment would silently produce a blob that never decrypts.
 */
export class BiometricNonDeterministicError extends Error {
  readonly code = 'BIOMETRIC_NON_DETERMINISTIC'
  constructor() {
    super(
      'Windows Hello produit des signatures non déterministes sur ce poste ; ' +
      'le déverrouillage biométrique ne peut pas être activé.',
    )
    this.name = 'BiometricNonDeterministicError'
  }
}

export interface SessionContent {
  unlockedAt: string
  lastActivityAt: string
  lockTimeoutMinutes: number
  lockedAt: string | null
  unlockerAppId: string
  sessionToken: string
}

export interface SessionState extends SessionContent {
  /** True if `now - lastActivityAt > lockTimeoutMinutes`. */
  isExpired: boolean
  /** True if `lockedAt !== null`. */
  isLocked: boolean
  /** True iff `!isLocked && !isExpired`. */
  isValid: boolean
}

export interface SessionFileEnvelope {
  version: number
  ciphertext: string
}

export interface CreateSessionServiceOpts {
  sharedDir: string
  appId: string
  /**
   * @deprecated since v1.1.3. session.bin is no longer DPAPI-encrypted because
   * Electron's safeStorage Master Key is per-app and cannot decrypt files
   * written by another app. The session file is now plain JSON in
   * %LOCALAPPDATA% (per-user, restricted by file permissions). Accepted for
   * backwards compat but unused; pass `undefined` or omit.
   */
  safeStorage?: SafeStorageLike
  /** Activity write throttle in ms (default 10_000). Test-only override. */
  activityThrottleMs?: number
  /** Watch event debounce in ms (default 100). Test-only override. */
  watchDebounceMs?: number
}
