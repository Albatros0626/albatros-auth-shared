"use strict";
/**
 * Browser-safe definition of the `GuardedError` shape returned by
 * `createGuardedHandle` (in `./guarded-handle.ts`) when an IPC call hits
 * a locked app.
 *
 * This file is split out so that the renderer can `import type` the shape
 * (and use the `isGuardedError` type guard) without pulling in the
 * Node-only `guarded-handle.ts` module via `@albatros/auth-shared`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isGuardedError = isGuardedError;
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
function isGuardedError(x) {
    if (typeof x !== 'object' || x === null)
        return false;
    const o = x;
    if (o.success !== false)
        return false;
    const err = o.error;
    if (typeof err !== 'object' || err === null)
        return false;
    return err.code === 'NOT_UNLOCKED';
}
//# sourceMappingURL=guarded-error-types.js.map