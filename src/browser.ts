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

export {
  createActivityTracker,
} from './activity-tracker'
export type {
  ActivityTracker,
  CreateActivityTrackerOpts,
} from './activity-tracker'

export {
  RECOVERY_QUESTIONS,
  CUSTOM_QUESTION_MIN_LENGTH,
  RECOVERY_ANSWER_MIN_LENGTH,
} from './recovery-questions'

export type { LockoutStatus } from './types'
