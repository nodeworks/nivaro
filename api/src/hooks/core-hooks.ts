import type { FastifyInstance } from 'fastify'
import { registerCoreTriggers } from '../flows/core-triggers.js'
import { registerActivityHooks } from './activity.js'
import { registerAgentTriggerHooks } from './agent-triggers.js'
import { registerAggregateCapHooks, setApp as setAggregateCapApp } from './aggregate-caps.js'
import { registerAiValidationHooks, setApp as setAiValidationApp } from './ai-validation.js'
import { registerAlertHooks, setApp as setAlertApp } from './alerts.js'
import { registerApprovalChangeHooks } from './approval-changes.js'
import { registerCrossTriggerHooks, setApp as setCrossTriggerApp } from './cross-triggers.js'
import { registerEmbeddingHooks, setApp as setEmbeddingApp } from './embeddings.js'
import { registerFieldWatchHooks, setApp as setFieldWatchApp } from './field-watches.js'
import { registerInactivePeopleHooks } from './inactive-people.js'
import { registerSnoozeWakeHooks } from './notification-snooze.js'
import {
  registerNotificationSubscriptionHooks,
  setApp as setSubscriptionApp
} from './notification-subscriptions.js'
import { registerPipelineAutostartHooks } from './pipeline-autostart.js'
import { registerPresenceTypingStripHooks } from './presence-typing-strip.js'
import { registerQueueMaterializationHooks } from './queue-materialization.js'
import { registerRecordIntegrityHooks } from './record-integrity.js'
import { registerTaskDoneWhenHooks } from './task-done-when.js'
import { registerWatchListHooks } from './watch-list.js'
import { registerWorkflowAutoHooks } from './workflow-auto.js'

/**
 * The core record hooks (activity log, revisions, webhooks, watches, subscriptions, alerts,
 * rules, integrity, automation …) and the core flow triggers, registered once per process.
 *
 * Self-hosted and on a Hub shared deployment (Hub phase 6, Task 13) index.ts calls these at boot;
 * Nivaro Cloud does not (unchanged). Every registrar only ADDS hooks; on a shared deployment none
 * reads a database while registering (cross-triggers' self-hosted warm-up is skipped there), and
 * each hook reads the database of the write it runs for (the tenant context), with any cache or
 * timer it keeps keyed per app. In this order (it is the run order).
 */
const REGISTRARS: Array<() => void> = [
  registerActivityHooks,
  registerFieldWatchHooks,
  registerWatchListHooks,
  registerInactivePeopleHooks,
  registerNotificationSubscriptionHooks,
  registerPipelineAutostartHooks,
  registerAlertHooks,
  registerEmbeddingHooks,
  registerCrossTriggerHooks,
  registerAiValidationHooks,
  registerAggregateCapHooks,
  registerQueueMaterializationHooks,
  registerRecordIntegrityHooks,
  registerSnoozeWakeHooks,
  registerTaskDoneWhenHooks,
  registerPresenceTypingStripHooks,
  registerAgentTriggerHooks,
  registerWorkflowAutoHooks,
  registerApprovalChangeHooks,
  registerCoreTriggers
]

let registered = false

/** Register every core hook and trigger, once. Returns false when they already were. */
export function registerCoreRecordHooks(): boolean {
  if (registered) return false
  registered = true
  for (const register of REGISTRARS) register()
  return true
}

/** The hooks that log or emit through Fastify / Socket.io get the app once it is built. */
export function setCoreHookApps(app: FastifyInstance): void {
  setFieldWatchApp(app)
  setSubscriptionApp(app)
  setAlertApp(app)
  setEmbeddingApp(app)
  setCrossTriggerApp(app)
  setAiValidationApp(app)
  setAggregateCapApp(app)
}
