"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOT_UNLOCKED_ERROR = exports.isGuardedError = void 0;
exports.createGuardedHandle = createGuardedHandle;
var guarded_error_types_1 = require("./guarded-error-types");
Object.defineProperty(exports, "isGuardedError", { enumerable: true, get: function () { return guarded_error_types_1.isGuardedError; } });
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
                return exports.NOT_UNLOCKED_ERROR;
            }
            return listener(event, ...args);
        });
    };
}
//# sourceMappingURL=guarded-handle.js.map