"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOT_UNLOCKED_ERROR = exports.NotUnlockedError = exports.isGuardedError = void 0;
exports.createGuardedHandle = createGuardedHandle;
var guarded_error_types_1 = require("./guarded-error-types");
Object.defineProperty(exports, "isGuardedError", { enumerable: true, get: function () { return guarded_error_types_1.isGuardedError; } });
/**
 * Thrown by `guardedHandle` when an IPC call hits a locked app. Electron
 * serializes thrown errors back to the renderer as a rejected promise with
 * `name` preserved — use `isNotUnlockedError(err)` (browser subpath) to
 * detect this case in a `try/catch`.
 *
 * @since v2.0.0 (replaces the v1.x `NOT_UNLOCKED_ERROR` envelope return).
 */
class NotUnlockedError extends Error {
    code = 'NOT_UNLOCKED';
    constructor(message = 'Application verrouillée, déverrouillez-la pour continuer.') {
        super(message);
        this.name = 'NotUnlockedError';
        // Restore prototype chain for `instanceof` to work after transpile (TS docs)
        Object.setPrototypeOf(this, NotUnlockedError.prototype);
    }
}
exports.NotUnlockedError = NotUnlockedError;
/**
 * @deprecated since v2.0.0 — `guardedHandle` now throws `NotUnlockedError`
 * instead of returning this envelope. Kept exported for back-compat of imports
 * from v1.x consumers; a future v3.0.0 may remove it.
 */
exports.NOT_UNLOCKED_ERROR = {
    success: false,
    error: {
        code: 'NOT_UNLOCKED',
        message: 'Application verrouillée, déverrouillez-la pour continuer.',
    },
};
function createGuardedHandle(opts) {
    const { ipcMain, authState } = opts;
    return function guardedHandle(channel, listener) {
        ipcMain.handle(channel, async (event, ...args) => {
            if (!authState.isUnlocked()) {
                throw new NotUnlockedError();
            }
            return listener(event, ...args);
        });
    };
}
//# sourceMappingURL=guarded-handle.js.map