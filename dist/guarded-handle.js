"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOT_UNLOCKED_ERROR = void 0;
exports.createGuardedHandle = createGuardedHandle;
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