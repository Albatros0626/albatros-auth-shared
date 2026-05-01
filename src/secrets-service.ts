import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync, unlinkSync } from 'fs'
import type {
  CreateSecretsServiceOpts,
  SafeStorageLike,
  SecretsVault,
} from './types'
import {
  DPAPIUnavailableError,
  KeyNotAllowedError,
  SecretsVaultVersionUnsupportedError,
} from './types'

export const SECRETS_VAULT_VERSION = 1

export interface SecretsService {
  isAvailable(): boolean
  setSecret(key: string, value: string): void
  getSecret(key: string): string | null
  hasSecret(key: string): boolean
  deleteSecret(key: string): void
  /** @internal Reserved for tests: returns the raw vault state. */
  __readVaultForTests(): SecretsVault
}

export function anonymizeKeyForLog(key: string): string {
  if (!key) return '***'
  const idx = key.indexOf('.')
  if (idx === -1) return '***'
  return `${key.slice(0, idx)}.***`
}

export function createSecretsService(opts: CreateSecretsServiceOpts): SecretsService {
  const { vaultPath, allowlist, safeStorage } = opts
  const allowSet = new Set(allowlist)

  function readVault(): SecretsVault {
    if (!existsSync(vaultPath)) {
      return { version: SECRETS_VAULT_VERSION, secrets: {} }
    }
    const raw = readFileSync(vaultPath, 'utf-8')
    const parsed = JSON.parse(raw) as SecretsVault
    if (parsed.version !== SECRETS_VAULT_VERSION) {
      throw new SecretsVaultVersionUnsupportedError(parsed.version)
    }
    return parsed
  }

  function writeVault(vault: SecretsVault): void {
    const tmp = `${vaultPath}.tmp`
    const content = JSON.stringify(vault, null, 2)
    try {
      writeFileSync(tmp, content, { mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { /* best effort on non-POSIX */ }
      renameSync(tmp, vaultPath)
    } catch (err) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  }

  function assertAllowed(key: string): void {
    if (!allowSet.has(key)) {
      throw new KeyNotAllowedError(key)
    }
  }

  function isAvailableImpl(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  return {
    isAvailable: isAvailableImpl,

    setSecret(key: string, value: string): void {
      assertAllowed(key)
      if (!isAvailableImpl()) {
        throw new DPAPIUnavailableError()
      }

      const encrypted = safeStorage.encryptString(value)
      const vault = readVault()
      vault.secrets[key] = encrypted.toString('base64')
      writeVault(vault)
    },

    getSecret(key: string): string | null {
      assertAllowed(key)
      if (!isAvailableImpl()) return null

      const vault = readVault()
      const b64 = vault.secrets[key]
      if (!b64) return null

      try {
        const buf = Buffer.from(b64, 'base64')
        return safeStorage.decryptString(buf)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[secrets] Failed to decrypt ${anonymizeKeyForLog(key)}:`, err)
        return null
      }
    },

    hasSecret(key: string): boolean {
      assertAllowed(key)
      const vault = readVault()
      return !!vault.secrets[key]
    },

    deleteSecret(key: string): void {
      assertAllowed(key)
      const vault = readVault()
      if (vault.secrets[key]) {
        delete vault.secrets[key]
        writeVault(vault)
      }
    },

    __readVaultForTests(): SecretsVault {
      return readVault()
    },
  }
}
