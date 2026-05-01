"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthState = createAuthState;
function createAuthState() {
    let unlocked = false;
    const listeners = new Set();
    return {
        isUnlocked() {
            return unlocked;
        },
        setUnlocked(v) {
            if (unlocked === v)
                return;
            unlocked = v;
            for (const listener of listeners) {
                try {
                    listener(v);
                }
                catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('[auth-state] unlock-change listener threw:', err);
                }
            }
        },
        onUnlockChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
//# sourceMappingURL=auth-state.js.map