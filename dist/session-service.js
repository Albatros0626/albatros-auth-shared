"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WATCH_DEBOUNCE_MS = exports.DEFAULT_ACTIVITY_THROTTLE_MS = exports.SESSION_FILE_VERSIONS_SUPPORTED = exports.SESSION_FILE_VERSION = exports.SESSION_FILENAME = void 0;
exports.createSessionService = createSessionService;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
exports.SESSION_FILENAME = 'session.bin';
/**
 * v1: DPAPI-encrypted envelope (`{ version: 1, ciphertext }`). Could not be
 *     decrypted across apps because Electron's safeStorage uses a Master Key
 *     stored per-app in `userData/Local State`.
 * v2: Plain JSON (`{ version: 2, ...content }`). The session file lives in
 *     `%LOCALAPPDATA%` (per-user) with file permissions restricting access
 *     to the owner. Content is not sensitive (timestamps + opaque token +
 *     appId), so OS-level isolation is sufficient and the cross-app sharing
 *     becomes reliable.
 */
exports.SESSION_FILE_VERSION = 2;
exports.SESSION_FILE_VERSIONS_SUPPORTED = [2];
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
    const { sharedDir, appId, activityThrottleMs = exports.DEFAULT_ACTIVITY_THROTTLE_MS, watchDebounceMs = exports.DEFAULT_WATCH_DEBOUNCE_MS, } = opts;
    // opts.safeStorage is deprecated and intentionally ignored — see CreateSessionServiceOpts.
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
            const parsed = JSON.parse(raw);
            if (!exports.SESSION_FILE_VERSIONS_SUPPORTED.includes(parsed.version)) {
                // v1 used DPAPI; can no longer be decrypted reliably across apps.
                // Treat as no session — next unlock will write a fresh v2 file.
                return null;
            }
            // v2: plain JSON, fields are at the top level alongside `version`.
            const { version: _v, ...content } = parsed;
            return content;
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[session] Failed to read session file:', err);
            return null;
        }
    }
    function writeContent(content) {
        ensureDir();
        const payload = { version: exports.SESSION_FILE_VERSION, ...content };
        // Per-writer tmp suffix so concurrent processes don't trip over each other:
        // without this, two workers writing simultaneously share `session.bin.tmp` and
        // the second's rename throws ENOENT after the first has already moved it.
        const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        try {
            (0, fs_1.writeFileSync)(tmp, JSON.stringify(payload), { mode: 0o600 });
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
            let lastSnapshot = null;
            const fireDebounced = () => {
                if (debounceTimer)
                    clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    debounceTimer = null;
                    try {
                        const state = readContent();
                        // De-dupe: only invoke the callback when the file content has
                        // actually changed since the last snapshot. fs.watch can fire
                        // many spurious events (per-pid tmp files, double-events on
                        // Windows rename, etc.) — content comparison filters those out.
                        const snapshot = state ? JSON.stringify(state) : null;
                        if (snapshot === lastSnapshot)
                            return;
                        lastSnapshot = snapshot;
                        cb(state ? deriveState(state) : null);
                    }
                    catch (err) {
                        // eslint-disable-next-line no-console
                        console.error('[session] watch callback failed:', err);
                    }
                }, watchDebounceMs);
            };
            try {
                ensureDir();
                // Listen to ANY change in the shared dir. Filtering by filename is
                // unreliable on Windows (filename can be null, the tmp name, or
                // session.bin depending on the rename event side). Debounce + content
                // comparison keeps the callback noise-free without missing events.
                watcher = (0, fs_1.watch)(sharedDir, () => fireDebounced());
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