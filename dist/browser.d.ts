/**
 * Browser-safe entry point for the renderer process.
 *
 * Only exports modules that do NOT import Node-only APIs (`fs`, `crypto`,
 * `electron`). Importing the main entry point `@albatros/auth-shared` from
 * the renderer would crash because Vite/esbuild can't resolve those Node
 * modules in the browser bundle.
 *
 * Usage:
 *   import { attachActivityTracking, RECOVERY_QUESTIONS } from '@albatros/auth-shared/browser'
 *
 * `createActivityTracker` is deliberately NOT exported here since v4.0.0: its
 * bare `onIdle` is how an app ended up locking every sibling on its own
 * inactivity (TROUBLESHOOTING Bug #5). In the renderer, idle detection goes
 * through `attachActivityTracking` or `useIdleLock`, which require a
 * `requestLock` answered by the main process.
 */
export { attachActivityTracking, DEFAULT_ACTIVITY_EVENTS, DEFAULT_IPC_THROTTLE_MS, } from './activity-listener';
export type { AttachActivityTrackingOpts, ActivityEventTarget, } from './activity-listener';
export { isGuardedError, isNotUnlockedError, } from './guarded-error-types';
export type { GuardedError } from './guarded-error-types';
export { RECOVERY_QUESTIONS, CUSTOM_QUESTION_MIN_LENGTH, RECOVERY_ANSWER_MIN_LENGTH, } from './recovery-questions';
export type { LockoutStatus, RequestLockReason, RequestLockResult } from './types';
//# sourceMappingURL=browser.d.ts.map