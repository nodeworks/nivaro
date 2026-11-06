import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { writeStartHistory } from '../services/instance-start.js'
import { isMachineAccount } from '../services/machine-accounts.js'
import { deferEffect } from '../services/unit-of-work.js'
import type { HookContext } from './registry.js'
import { hooks } from './registry.js'

function coerceBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  if (typeof val === 'string') return val === '1' || val === 'true'
  return false
}

/** Request paths whose creates are bulk loads, never one person's new record. */
const BULK_CREATE_PATH =
  /^\/api\/(imports|import-templates|staged-imports|inbound|inbound-mappings|sync-jobs)(\/|$)/

/** Credentials scripts and integrations use — their creates are machine work. */
const MACHINE_AUTH = new Set(['api_key', 'token', 'key_sim'])

/**
 * Whether an auto-started instance should be ANNOUNCED — the
 * `workflow-transition` event + state subscriptions a transition fires, so the
 * start state's owners hear about the new record. Returns the reason it is
 * not announced, or null when it is.
 *
 * Only a record that starts PAST the initial state is announced (an IR
 * created straight into Engineering Review, army4 a14-23): a record parked in
 * Started waits on its creator, who just made it. Machine creates — imports,
 * inbound feeds, integrations, API keys, anything without a request — never
 * are: a bulk load must not mail every owner of every row.
 */
export function autostartSilenceReason(
  ctx: Pick<HookContext, 'user' | 'req' | 'dryRun'>,
  startState: { is_initial?: unknown }
): string | null {
  if (ctx.dryRun) return 'dry-run'
  if (coerceBool(startState.is_initial)) return 'initial-state'
  if (!ctx.user) return 'no-user'
  if (isMachineAccount(ctx.user)) return 'machine-account'
  const req = ctx.req as
    | { url?: string; raw?: { url?: string }; authMethod?: string | null }
    | undefined
  if (!req) return 'no-request'
  if (req.authMethod && MACHINE_AUTH.has(req.authMethod)) return 'machine-auth'
  const path = String(req.raw?.url ?? req.url ?? '').split('?')[0]
  if (BULK_CREATE_PATH.test(path)) return 'bulk-create'
  return null
}

export function registerPipelineAutostartHooks() {
  hooks.after('*', 'create', (ctx) =>
    deferEffect('pipeline-autostart', async () => {
      if (ctx.collection.startsWith('nivaro_')) return
      const item = ctx.keys?.[0] != null ? String(ctx.keys[0]) : null
      if (!item) return

      try {
        const binding = await db('nivaro_workflow_bindings')
          .where({ collection: ctx.collection })
          .first()
        if (!binding || !coerceBool(binding.auto_start)) return

        // Don't double-start
        const existing = await db('nivaro_workflow_instances')
          .where({ collection: ctx.collection, item })
          .first()
        if (existing) return

        // Determine start state
        const startState = binding.auto_start_state
          ? await db('nivaro_workflow_states')
              .where({ id: binding.auto_start_state, template: binding.template })
              .first()
          : await db('nivaro_workflow_states')
              .where({ template: binding.template, is_initial: true })
              .orderBy('sort')
              .first()

        if (!startState) return

        const instanceId = randomUUID()
        const now = new Date()

        await db('nivaro_workflow_instances').insert({
          id: instanceId,
          template: binding.template,
          collection: ctx.collection,
          item,
          current_state: startState.id,
          started_at: now,
          completed_at: coerceBool(startState.is_terminal) ? now : null
        })

        // #1219: the start is history — the binding started it, not a person.
        await writeStartHistory({
          instanceId,
          stateId: String(startState.id),
          userId: ctx.user?.id ?? null,
          origin: 'machine',
          timestamp: now
        })

        // Mirror the state the way every transition does (state_field_map
        // honoured — a raw key into an INT legacy column silently no-opped).
        if (binding.state_field && startState.key) {
          const { syncStateField } = await import('../services/workflow-transitions.js')
          await syncStateField(ctx.collection, item, startState).catch(() => {})
        }

        // A record that starts past the initial state never transitions into
        // it, so nothing told that state's owners it exists: tell them the way
        // a transition does (flows + state subscriptions). Best-effort.
        if (autostartSilenceReason(ctx, startState) === null) {
          const { emitWorkflowStartEvent } = await import('../services/workflow-transitions.js')
          await emitWorkflowStartEvent({
            instanceId,
            collection: ctx.collection,
            item,
            template: String(binding.template),
            stateId: String(startState.id),
            userId: ctx.user?.id ?? null,
            label: 'Created',
            source: 'auto'
          })
        }
      } catch {
        // Non-fatal — never block item creation
      }
    })
  )
}
