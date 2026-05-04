/**
 * Browser-safe definition of the `GuardedError` shape returned by
 * `createGuardedHandle` (in `./guarded-handle.ts`) when an IPC call hits
 * a locked app.
 *
 * This file is split out so that the renderer can `import type` the shape
 * (and use the `isGuardedError` type guard) without pulling in the
 * Node-only `guarded-handle.ts` module via `@albatros/auth-shared`.
 */
export interface GuardedError {
    success: false;
    error: {
        code: 'NOT_UNLOCKED';
        message: string;
    };
}
/**
 * Type guard for the `NOT_UNLOCKED` shape returned by guarded IPC handlers
 * when the app is locked. Useful in the renderer to distinguish a real
 * payload from a "I-was-locked-don't-bother" envelope without crashing
 * downstream code that assumes `Array.isArray(result)` or similar.
 *
 * Recommended usage in stores:
 *
 * ```ts
 * const result = await window.electronAPI.getContacts()
 * if (isGuardedError(result)) {
 *   // The fetch raced a lock — clear and let the next post-unlock fetch repopulate.
 *   set({ contacts: [] })
 *   return
 * }
 * set({ contacts: result })
 * ```
 *
 * In v2.0.0 the package will throw instead of returning this envelope, and
 * this helper will become unnecessary.
 */
export declare function isGuardedError(x: unknown): x is GuardedError;
/**
 * Type guard for the v2.0.0+ exception thrown by `guardedHandle` when the
 * app is locked. Electron preserves `name` across the IPC boundary, so this
 * works in the renderer too:
 *
 * ```ts
 * try {
 *   const result = await window.electronAPI.getContacts()
 *   // result is the actual array — no shape check needed
 * } catch (err) {
 *   if (isNotUnlockedError(err)) {
 *     // The fetch raced a lock — ignore silently; next post-unlock fetch will repopulate.
 *     return
 *   }
 *   throw err
 * }
 * ```
 */
export declare function isNotUnlockedError(err: unknown): boolean;
//# sourceMappingURL=guarded-error-types.d.ts.map