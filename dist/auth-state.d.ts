export type UnlockListener = (unlocked: boolean) => void;
export interface AuthState {
    isUnlocked(): boolean;
    setUnlocked(v: boolean): void;
    onUnlockChange(listener: UnlockListener): () => void;
}
export declare function createAuthState(): AuthState;
//# sourceMappingURL=auth-state.d.ts.map