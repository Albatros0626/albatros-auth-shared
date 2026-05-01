"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WATCH_DEBOUNCE_MS = exports.DEFAULT_ACTIVITY_THROTTLE_MS = exports.SESSION_FILE_VERSION = exports.SESSION_FILENAME = void 0;
exports.createSessionService = createSessionService;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
exports.SESSION_FILENAME = 'session.bin';
exports.SESSION_FILE_VERSION = 1;
exports.DEFAULT_ACTIVITY_THROTTLE_MS = 10_000;
exports.DEFAULT_WATCH_DEBOUNCE_MS = 100;
function nowIso() {
    return new Date().toISOString();
}
function randomToken() {
    return (0, crypto_1.randomBytes)(32).toString('hex');
}
function deriveState(content) {
    const isLocked = content.lockedAt !== null;
    const lastActivityMs = new Date(content.lastActivityAt).getTime();
    const timeoutMs = content.lockTimeoutMinutes * 60 * 1000;
    const isExpired = content.lockTimeoutMinutes > 0 && Date.now() - lastActivityMs > timeoutMs;
    return {
        ...content,
        isLocked,
        isExpired,
        isValid: !isLocked && !isExpired,
    };
}
function createSessionService(opts) {
    const { sharedDir, appId, safeStorage, activityThrottleMs = exports.DEFAULT_ACTIVITY_THROTTLE_MS, watchDebounceMs = exports.DEFAULT_WATCH_DEBOUNCE_MS, } = opts;
    const filePath = path_1.default.join(sharedDir, exports.SESSION_FILENAME);
    let activityTimer = null;
    function ensureDir() {
        if (!(0, fs_1.existsSync)(sharedDir)) {
            (0, fs_1.mkdirSync)(sharedDir, { recursive: true });
        }
    }
    function readContent() {
        if (!(0, fs_1.existsSync)(filePath))
            return null;
        try {
            const raw = (0, fs_1.readFileSync)(filePath, 'utf-8');
            const envelope = JSON.parse(raw);
            if (envelope.version !== exports.SESSION_FILE_VERSION)
                return null;
            const cipher = Buffer.from(envelope.ciphertext, 'base64');
            const json = safeStorage.decryptString(cipher);
            return JSON.parse(json);
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[session] Failed to read session file:', err);
            return null;
        }
    }
    function writeContent(content) {
        ensureDir();
        const json = JSON.stringify(content);
        const cipher = safeStorage.encryptString(json);
        const envelope = {
            version: exports.SESSION_FILE_VERSION,
            ciphertext: cipher.toString('base64'),
        };
        const tmp = `${filePath}.tmp`;
        try {
            (0, fs_1.writeFileSync)(tmp, JSON.stringify(envelope), { mode: 0o600 });
            (0, fs_1.renameSync)(tmp, filePath);
        }
        catch (err) {
            try {
                if ((0, fs_1.existsSync)(tmp))
                    (0, fs_1.unlinkSync)(tmp);
            }
            catch { /* ignore */ }
            throw err;
        }
    }
    function flushActivity() {
        if (activityTimer) {
            clearTimeout(activityTimer);
            activityTimer = null;
            const content = readContent();
            if (content) {
                content.lastActivityAt = nowIso();
                writeContent(content);
            }
        }
    }
    return {
        read() {
            const content = readContent();
            return content ? deriveState(content) : null;
        },
        recordUnlock({ lockTimeoutMinutes }) {
            const now = nowIso();
            const content = {
                unlockedAt: now,
                lastActivityAt: now,
                lockTimeoutMinutes,
                lockedAt: null,
                unlockerAppId: appId,
                sessionToken: randomToken(),
            };
            writeContent(content);
            return deriveState(content);
        },
        recordLock() {
            const content = readContent();
            if (!content)
                return;
            content.lockedAt = nowIso();
            writeContent(content);
        },
        recordActivity() {
            // Leading-skip + trailing-write throttle: schedule a single write at the
            // end of the throttle window. Captures bursts of events with one write.
            if (activityTimer)
                return;
            activityTimer = setTimeout(() => {
                activityTimer = null;
                const content = readContent();
                if (!content)
                    return;
                content.lastActivityAt = nowIso();
                writeContent(content);
            }, activityThrottleMs);
        },
        watch(cb) {
            let debounceTimer = null;
            let watcher = null;
            try {
                ensureDir();
                watcher = (0, fs_1.watch)(sharedDir, (_eventType, filename) => {
                    if (filename !== exports.SESSION_FILENAME)
                        return;
                    if (debounceTimer)
                        clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        debounceTimer = null;
                        try {
                            const state = readContent();
                            cb(state ? deriveState(state) : null);
                        }
                        catch (err) {
                            // eslint-disable-next-line no-console
                            console.error('[session] watch callback failed:', err);
                        }
                    }, watchDebounceMs);
                });
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.error('[session] fs.watch failed:', err);
            }
            return () => {
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                    debounceTimer = null;
                }
                if (watcher) {
                    try {
                        watcher.close();
                    }
                    catch { /* ignore */ }
                    watcher = null;
                }
            };
        },
        __flushPendingForTests() {
            flushActivity();
        },
    };
}
//# sourceMappingURL=session-service.js.map