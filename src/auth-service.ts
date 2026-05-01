import { promisify } from 'util'
import { pbkdf2, randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs'
import {
  CUSTOM_QUESTION_MIN_LENGTH,
  RECOVERY_ANSWER_MIN_LENGTH,
} from './recovery-questions'
import type {
  AuthVault,
  CreateAuthServiceOpts,
  LockoutStatus,
  SetupOpts,
} from './types'
import { VaultNotInitializedError, VaultVersionUnsupportedError } from './types'

const pbkdf2Async = promisify(pbkdf2)

export const PBKDF2_ITERATIONS = 600_000
export const PBKDF2_KEYLEN = 64
export const PBKDF2_DIGEST = 'sha512'
export const SALT_LENGTH = 16

export const CODE_MIN_LENGTH = 6
export const VAULT_VERSION = 2
export const SUPPORTED_VAULT_VERSIONS: readonly number[] = [1, 2]

export const LOCKOUT_THRESHOLD = 5
export const LOCKOUT_DURATION_MS = 30 * 60 * 1000
export const DELAY_START_AT_ATTEMPT = 3
export const DELAY_MAX_SECONDS = 30

export const DEFAULT_LOCK_TIMEOUT_MINUTES = 10

const TRIVIAL_PATTERNS = [
  '123456', '234567', '345678', '456789', '567890', '654321',
  'qwerty', 'azerty', 'abcdef',
]

export function normalizeAnswer(s: string): string {
  return s
    .normalize('NFD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

async function derive(secret: string, salt: Buffer): Promise<Buffer> {
  return pbkdf2Async(secret, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function computeDelaySeconds(attempts: number): number {
  if (attempts < DELAY_START_AT_ATTEMPT) return 0
  const delay = 2 ** (attempts - (DELAY_START_AT_ATTEMPT - 1))
  return Math.min(DELAY_MAX_SECONDS, delay)
}

function isTrivialCode(code: string): boolean {
  const lower = code.toLowerCase()
  if (TRIVIAL_PATTERNS.includes(lower)) return true
  if (new Set(lower).size === 1) return true
  if (/^\d+$/.test(code) && code.length >= 6) {
    const digits = code.split('').map(Number)
    const asc = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1)
    const desc = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1)
    if (asc || desc) return true
  }
  return false
}

export function validateCode(code: string): { valid: boolean; reason?: string } {
  if (code.length < CODE_MIN_LENGTH) {
    return { valid: false, reason: `Minimum ${CODE_MIN_LENGTH} caractères` }
  }
  if (isTrivialCode(code)) {
    return { valid: false, reason: 'Code trop simple (suite ou répétition)' }
  }
  return { valid: true }
}

export interface AuthService {
  isSetupComplete(): boolean
  setup(opts: SetupOpts): Promise<void>
  verifyCode(code: string): Promise<boolean>
  verifyCurrentCode(code: string): Promise<boolean>
  testRecovery(answer: string): Promise<boolean>
  recover(answer: string, newCode: string): Promise<void>
  changeCode(oldCode: string, newCode: string): Promise<void>
  changeRecovery(currentCode: string, newQuestion: string, newAnswer: string): Promise<void>
  getRecoveryQuestion(): string
  getLastCodeChangeDate(): string | null
  getLockoutStatus(): LockoutStatus
  getLockTimeoutMinutes(): number
  setLockTimeoutMinutes(minutes: number): void
}

export function createAuthService(opts: CreateAuthServiceOpts): AuthService {
  const { vaultPath } = opts

  function readVault(): AuthVault | null {
    if (!existsSync(vaultPath)) return null
    const raw = readFileSync(vaultPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AuthVault> & { version: number }

    if (!SUPPORTED_VAULT_VERSIONS.includes(parsed.version)) {
      throw new VaultVersionUnsupportedError(parsed.version, SUPPORTED_VAULT_VERSIONS)
    }

    if (parsed.version === 1) {
      return migrateV1ToV2(parsed as AuthVault)
    }

    return parsed as AuthVault
  }

  function migrateV1ToV2(legacy: AuthVault): AuthVault {
    const migrated: AuthVault = {
      ...legacy,
      version: 2,
      schemaCompat: [1, 2],
      lockTimeoutMinutes: DEFAULT_LOCK_TIMEOUT_MINUTES,
    }
    writeVault(migrated)
    return migrated
  }

  function writeVault(vault: AuthVault): void {
    writeFileSync(vaultPath, JSON.stringify(vault, null, 2), { mode: 0o600 })
    try { chmodSync(vaultPath, 0o600) } catch { /* best effort on non-POSIX */ }
  }

  function requireVault(): AuthVault {
    const v = readVault()
    if (!v) throw new VaultNotInitializedError()
    return v
  }

  return {
    isSetupComplete(): boolean {
      return existsSync(vaultPath)
    },

    async setup({ code, recoveryQuestion, recoveryAnswer }: SetupOpts): Promise<void> {
      if (existsSync(vaultPath)) {
        throw new Error('Setup already complete')
      }

      const codeCheck = validateCode(code)
      if (!codeCheck.valid) {
        throw new Error(codeCheck.reason)
      }

      if (!recoveryQuestion.trim() || recoveryQuestion.trim().length < CUSTOM_QUESTION_MIN_LENGTH) {
        throw new Error(`Question trop courte (minimum ${CUSTOM_QUESTION_MIN_LENGTH} caractères)`)
      }

      const normalizedAnswer = normalizeAnswer(recoveryAnswer)
      if (normalizedAnswer.length < RECOVERY_ANSWER_MIN_LENGTH) {
        throw new Error(`Réponse trop courte (minimum ${RECOVERY_ANSWER_MIN_LENGTH} caractères)`)
      }

      const saltCode = randomBytes(SALT_LENGTH)
      const saltRecovery = randomBytes(SALT_LENGTH)
      const hashCode = await derive(code, saltCode)
      const hashRecovery = await derive(normalizedAnswer, saltRecovery)

      const now = new Date().toISOString()
      const vault: AuthVault = {
        version: VAULT_VERSION,
        schemaCompat: [1, 2],
        created_at: now,
        last_code_change: now,
        pbkdf2_iterations: PBKDF2_ITERATIONS,
        salt_code: saltCode.toString('base64'),
        hash_code: hashCode.toString('base64'),
        salt_recovery: saltRecovery.toString('base64'),
        recovery_question: recoveryQuestion.trim(),
        hash_recovery: hashRecovery.toString('base64'),
        failed_attempts: 0,
        lockout_until: null,
        lockTimeoutMinutes: DEFAULT_LOCK_TIMEOUT_MINUTES,
      }
      writeVault(vault)
    },

    async verifyCode(code: string): Promise<boolean> {
      const vault = requireVault()

      // Anti timing-attack: derive ALWAYS, even if code too short or lockout active.
      const codeForDerivation = code.length > 0 ? code : ' '
      const hashCandidate = await derive(codeForDerivation, Buffer.from(vault.salt_code, 'base64'))
      const hashStored = Buffer.from(vault.hash_code, 'base64')

      if (code.length < CODE_MIN_LENGTH) return false

      if (vault.lockout_until && new Date(vault.lockout_until).getTime() > Date.now()) {
        return false
      }

      if (constantTimeEqual(hashCandidate, hashStored)) {
        vault.failed_attempts = 0
        vault.lockout_until = null
        writeVault(vault)
        return true
      }

      vault.failed_attempts += 1
      if (vault.failed_attempts >= LOCKOUT_THRESHOLD) {
        vault.lockout_until = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
      }
      writeVault(vault)
      return false
    },

    async verifyCurrentCode(code: string): Promise<boolean> {
      const vault = requireVault()
      const hashCandidate = await derive(code, Buffer.from(vault.salt_code, 'base64'))
      const hashStored = Buffer.from(vault.hash_code, 'base64')
      return constantTimeEqual(hashCandidate, hashStored)
    },

    async testRecovery(answer: string): Promise<boolean> {
      const vault = requireVault()
      const normalized = normalizeAnswer(answer)
      const hashCandidate = await derive(normalized, Buffer.from(vault.salt_recovery, 'base64'))
      const hashStored = Buffer.from(vault.hash_recovery, 'base64')
      return constantTimeEqual(hashCandidate, hashStored)
    },

    async recover(answer: string, newCode: string): Promise<void> {
      const vault = requireVault()

      if (vault.lockout_until && new Date(vault.lockout_until).getTime() > Date.now()) {
        throw new Error('Application verrouillée, réessayez plus tard')
      }

      const codeCheck = validateCode(newCode)
      if (!codeCheck.valid) {
        throw new Error(codeCheck.reason)
      }

      const normalized = normalizeAnswer(answer)
      const hashCandidate = await derive(normalized, Buffer.from(vault.salt_recovery, 'base64'))
      const hashStored = Buffer.from(vault.hash_recovery, 'base64')

      if (!constantTimeEqual(hashCandidate, hashStored)) {
        vault.failed_attempts += 1
        if (vault.failed_attempts >= LOCKOUT_THRESHOLD) {
          vault.lockout_until = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
        }
        writeVault(vault)
        throw new Error('Réponse incorrecte')
      }

      const saltCode = randomBytes(SALT_LENGTH)
      const hashCode = await derive(newCode, saltCode)
      vault.salt_code = saltCode.toString('base64')
      vault.hash_code = hashCode.toString('base64')
      vault.last_code_change = new Date().toISOString()
      vault.failed_attempts = 0
      vault.lockout_until = null
      writeVault(vault)
    },

    async changeCode(oldCode: string, newCode: string): Promise<void> {
      const vault = requireVault()

      const oldHash = await derive(oldCode, Buffer.from(vault.salt_code, 'base64'))
      const stored = Buffer.from(vault.hash_code, 'base64')
      if (!constantTimeEqual(oldHash, stored)) {
        throw new Error('Ancien code incorrect')
      }

      const codeCheck = validateCode(newCode)
      if (!codeCheck.valid) {
        throw new Error(codeCheck.reason)
      }

      const saltCode = randomBytes(SALT_LENGTH)
      const hashCode = await derive(newCode, saltCode)
      vault.salt_code = saltCode.toString('base64')
      vault.hash_code = hashCode.toString('base64')
      vault.last_code_change = new Date().toISOString()
      writeVault(vault)
    },

    async changeRecovery(
      currentCode: string,
      newQuestion: string,
      newAnswer: string,
    ): Promise<void> {
      const vault = requireVault()

      const candidate = await derive(currentCode, Buffer.from(vault.salt_code, 'base64'))
      const stored = Buffer.from(vault.hash_code, 'base64')
      if (!constantTimeEqual(candidate, stored)) {
        throw new Error('Code actuel incorrect')
      }

      if (!newQuestion.trim() || newQuestion.trim().length < CUSTOM_QUESTION_MIN_LENGTH) {
        throw new Error(`Question trop courte (minimum ${CUSTOM_QUESTION_MIN_LENGTH} caractères)`)
      }

      const normalized = normalizeAnswer(newAnswer)
      if (normalized.length < RECOVERY_ANSWER_MIN_LENGTH) {
        throw new Error(`Réponse trop courte (minimum ${RECOVERY_ANSWER_MIN_LENGTH} caractères)`)
      }

      const saltRecovery = randomBytes(SALT_LENGTH)
      const hashRecovery = await derive(normalized, saltRecovery)
      vault.salt_recovery = saltRecovery.toString('base64')
      vault.recovery_question = newQuestion.trim()
      vault.hash_recovery = hashRecovery.toString('base64')
      writeVault(vault)
    },

    getRecoveryQuestion(): string {
      const vault = requireVault()
      return vault.recovery_question
    },

    getLastCodeChangeDate(): string | null {
      const vault = readVault()
      if (!vault) return null
      return vault.last_code_change
    },

    getLockoutStatus(): LockoutStatus {
      const vault = readVault()
      if (!vault) {
        return { locked_until: null, attempts_remaining: LOCKOUT_THRESHOLD, required_delay_seconds: 0 }
      }

      const now = Date.now()
      const lockedUntil = vault.lockout_until && new Date(vault.lockout_until).getTime() > now
        ? vault.lockout_until
        : null

      const attemptsRemaining = Math.max(0, LOCKOUT_THRESHOLD - vault.failed_attempts)
      const requiredDelay = lockedUntil ? 0 : computeDelaySeconds(vault.failed_attempts)

      return {
        locked_until: lockedUntil,
        attempts_remaining: attemptsRemaining,
        required_delay_seconds: requiredDelay,
      }
    },

    getLockTimeoutMinutes(): number {
      const vault = readVault()
      if (!vault) return DEFAULT_LOCK_TIMEOUT_MINUTES
      return vault.lockTimeoutMinutes
    },

    setLockTimeoutMinutes(minutes: number): void {
      if (!Number.isInteger(minutes) || minutes < 0) {
        throw new Error('lockTimeoutMinutes must be a non-negative integer')
      }
      const vault = requireVault()
      vault.lockTimeoutMinutes = minutes
      writeVault(vault)
    },
  }
}
