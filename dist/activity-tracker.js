"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createActivityTracker = createActivityTracker;
function createActivityTracker(opts) {
    const { timeoutMs, onIdle } = opts;
    let active = false;
    let idleTimer = null;
    function scheduleCheck() {
        if (idleTimer)
            clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (!active)
                return;
            try {
                onIdle();
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.error('[activity-tracker] onIdle threw:', err);
            }
        }, timeoutMs);
    }
    function clear() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }
    return {
        recordActivity() {
            if (!active || timeoutMs <= 0)
                return;
            scheduleCheck();
        },
        start() {
            if (active)
                return;
            active = true;
            if (timeoutMs > 0)
                scheduleCheck();
        },
        stop() {
            active = false;
            clear();
        },
        isActive() {
            return active;
        },
    };
}
//# sourceMappingURL=activity-tracker.js.map