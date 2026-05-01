export const VERSION = '0.3.0' as const

export {
  createAuthService,
  validateCode,
  normalizeAnswer,
  PBKDF2_ITERATIONS,
  PBKDF2_KEYLEN,
  PBKDF2_DIGEST,
  SALT_LENGTH,
  CODE_MIN_LENGTH,
  VAULT_VERSION,
  SUPPORTED_VAULT_VERSIONS,
  LOCKOUT_THRESHOLD,
  LOCKOUT_DURATION_MS,
  DELAY_START_AT_ATTEMPT,
  DELAY_MAX_SECONDS,
  DEFAULT_LOCK_TIMEOUT_MINUTES,
} from './auth-service'

export type { AuthService } from './auth-service'

export {
  createSecretsService,
  anonymizeKeyForLog,
  SECRETS_VAULT_VERSION,
} from './secrets-service'

export type { SecretsService } from './secrets-service'

export {
  RECOVERY_QUESTIONS,
  CUSTOM_QUESTION_MIN_LENGTH,
  RECOVERY_ANSWER_MIN_LENGTH,
} from './recovery-questions'

export type {
  LockoutStatus,
  AuthVault,
  SetupOpts,
  CreateAuthServiceOpts,
  SafeStorageLike,
  SecretsVault,
  CreateSecretsServiceOpts,
} from './types'

export {
  VaultVersionUnsupportedError,
  VaultNotInitializedError,
  KeyNotAllowedError,
  DPAPIUnavailableError,
  SecretsVaultVersionUnsupportedError,
} from './types'
