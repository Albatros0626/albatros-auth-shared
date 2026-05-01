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
