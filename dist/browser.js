"use strict";
/**
 * Browser-safe entry point for the renderer process.
 *
 * Only exports modules that do NOT import Node-only APIs (`fs`, `crypto`,
 * `electron`). Importing the main entry point `@albatros/auth-shared` from
 * the renderer would crash because Vite/esbuild can't resolve those Node
 * modules in the browser bundle.
 *
 * Usage:
 *   import { createActivityTracker, RECOVERY_QUESTIONS } from '@albatros/auth-shared/browser'
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECOVERY_ANSWER_MIN_LENGTH = exports.CUSTOM_QUESTION_MIN_LENGTH = exports.RECOVERY_QUESTIONS = exports.isNotUnlockedError = exports.isGuardedError = exports.DEFAULT_IPC_THROTTLE_MS = exports.DEFAULT_ACTIVITY_EVENTS = exports.attachActivityTracking = exports.createActivityTracker = void 0;
var activity_tracker_1 = require("./activity-tracker");
Object.defineProperty(exports, "createActivityTracker", { enumerable: true, get: function () { return activity_tracker_1.createActivityTracker; } });
var activity_listener_1 = require("./activity-listener");
Object.defineProperty(exports, "attachActivityTracking", { enumerable: true, get: function () { return activity_listener_1.attachActivityTracking; } });
Object.defineProperty(exports, "DEFAULT_ACTIVITY_EVENTS", { enumerable: true, get: function () { return activity_listener_1.DEFAULT_ACTIVITY_EVENTS; } });
Object.defineProperty(exports, "DEFAULT_IPC_THROTTLE_MS", { enumerable: true, get: function () { return activity_listener_1.DEFAULT_IPC_THROTTLE_MS; } });
var guarded_error_types_1 = require("./guarded-error-types");
Object.defineProperty(exports, "isGuardedError", { enumerable: true, get: function () { return guarded_error_types_1.isGuardedError; } });
Object.defineProperty(exports, "isNotUnlockedError", { enumerable: true, get: function () { return guarded_error_types_1.isNotUnlockedError; } });
var recovery_questions_1 = require("./recovery-questions");
Object.defineProperty(exports, "RECOVERY_QUESTIONS", { enumerable: true, get: function () { return recovery_questions_1.RECOVERY_QUESTIONS; } });
Object.defineProperty(exports, "CUSTOM_QUESTION_MIN_LENGTH", { enumerable: true, get: function () { return recovery_questions_1.CUSTOM_QUESTION_MIN_LENGTH; } });
Object.defineProperty(exports, "RECOVERY_ANSWER_MIN_LENGTH", { enumerable: true, get: function () { return recovery_questions_1.RECOVERY_ANSWER_MIN_LENGTH; } });
//# sourceMappingURL=browser.js.map