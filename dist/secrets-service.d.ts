import type { CreateSecretsServiceOpts, SecretsVault } from './types';
export declare const SECRETS_VAULT_VERSION = 1;
export interface SecretsService {
    isAvailable(): boolean;
    setSecret(key: string, value: string): void;
    getSecret(key: string): string | null;
    hasSecret(key: string): boolean;
    deleteSecret(key: string): void;
    /** @internal Reserved for tests: returns the raw vault state. */
    __readVaultForTests(): SecretsVault;
}
export declare function anonymizeKeyForLog(key: string): string;
export declare function createSecretsService(opts: CreateSecretsServiceOpts): SecretsService;
//# sourceMappingURL=secrets-service.d.ts.map