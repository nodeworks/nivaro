import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { onTriggerEmitted, registerOp } from '../flows/registry.js'
import {
  type AgentEvent,
  fireAgentTriggers,
  queueWakeUp
} from '../services/agent-trigger-delivery.js'
import { type AgentTriggerRow, agentTriggersReady } from '../services/agent-triggers.js'
import { resolveTemplate } from '../services/flow-template-render.js'
import { originForWrite } from '../services/note-authorship.js'
import { deferEffect } from '../services/unit-of-work.js'
import { hooks } from './registry.js'

/**
 * Agent triggers (#3210): record creates and updates (through the items service) and
 * workflow transitions wake the agent triggers that match. The work runs after the write
 * commits (deferEffect), on the background pool, and never blocks or fails the write.
 */

function changedFields(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined
): string[] {
  const keys = Object.keys(payload ?? {})
  if (!previous || !next) return keys
  return keys.filter((k) => JSON.stringify(previous[k] ?? null) !== JSON.stringify(next[k] ?? null))
}

function fire(ev: AgentEvent): void {
  void runInBackgroundPool(() => fireAgentTriggers(ev)).catch(() => undefined)
}

type StateRef = { key?: string | null; label?: string | null } | null

let registered = false

export function registerAgentTriggerHooks(): void {
  if (registered) return
  registered = true

  hooks.after('*', 'create', async (ctx) => {
    if (ctx.dryRun) return
    const row = (ctx.result ?? null) as Record<string, unknown> | null
    const id = row?.id ?? ctx.keys?.[0]
    if (id == null || /^(nivaro|directus)_/i.test(ctx.collection)) return
    await deferEffect('agent-triggers:create', () =>
      fire({
        collection: ctx.collection,
        item: String(id),
        event: 'create',
        data: row,
        origin: originForWrite(ctx.user, ctx.changeReason),
        actor: ctx.user?.id ?? null
      })
    )
  })

  hooks.after('*', 'update', async (ctx) => {
    if (ctx.dryRun || /^(nivaro|directus)_/i.test(ctx.collection)) return
    const row = (ctx.result ?? null) as Record<string, unknown> | null
    const previous = (ctx.previousData ?? null) as Record<string, unknown> | null
    const changed = changedFields(previous, row, ctx.payload as Record<string, unknown>)
    const origin = originForWrite(ctx.user, ctx.changeReason)
    for (const key of ctx.keys ?? []) {
      await deferEffect('agent-triggers:update', () =>
        fire({
          collection: ctx.collection,
          item: String(key),
          event: 'update',
          // A bulk update's result is one row: only a single-key write's row is that record.
          data: (ctx.keys?.length ?? 0) === 1 ? row : null,
          changed_fields: changed,
          origin,
          actor: ctx.user?.id ?? null
        })
      )
    }
  })

  onTriggerEmitted('workflow-transition', (payload, userId) => {
    const collection = String(payload.collection ?? '')
    const item = payload.item == null ? '' : String(payload.item)
    if (!collection || !item || collection === 'nivaro_addendums') return
    fire({
      collection,
      item,
      event: 'transition',
      origin: payload.source === 'auto' ? 'machine' : 'person',
      actor: userId ?? null,
      transition: {
        label: (payload.transition_label as string | null) ?? null,
        source: (payload.source as string | null) ?? null,
        from_state: (payload.from_state as StateRef) ?? null,
        to_state: (payload.to_state as StateRef) ?? null
      }
    })
  })

  registerOp({
    type: 'wake-agent',
    label: 'Wake an agent',
    color: '#0ea5e9',
    description:
      "Posts the record's context to an agent trigger's endpoint (signed, retried, logged under MCP → Agent triggers). " +
      "The record is read as the trigger's owner. Use it when a flow decides when to wake the agent; " +
      "the trigger's own events and conditions are not applied.",
    fields: [
      {
        key: 'trigger_id',
        label: 'Agent trigger id',
        type: 'number',
        required: true,
        description: 'The id shown on MCP → Agent triggers.'
      },
      {
        key: 'collection',
        label: 'Collection',
        type: 'string',
        placeholder: '{{collection}}',
        defaultValue: '{{collection}}'
      },
      {
        key: 'item',
        label: 'Record id',
        type: 'string',
        placeholder: '{{item}}',
        defaultValue: '{{item}}'
      }
    ],
    handler: async (opts, data, ctx) => {
      if (!(await agentTriggersReady()))
        return { status: 'reject', output: { ...data, $error: 'agent triggers are not set up' } }
      const id = Number(opts.trigger_id)
      const trigger = Number.isInteger(id)
        ? ((await db('nivaro_agent_triggers').where({ id }).first()) as AgentTriggerRow | undefined)
        : undefined
      if (!trigger)
        return { status: 'reject', output: { ...data, $error: 'unknown agent trigger' } }
      if (!trigger.enabled)
        return { status: 'reject', output: { ...data, $error: 'agent trigger is turned off' } }
      const collection = resolveTemplate(String(opts.collection ?? '{{collection}}'), data)
      const item = resolveTemplate(String(opts.item ?? '{{item}}'), data)
      if (!collection || !item || collection !== trigger.collection)
        return {
          status: 'reject',
          output: { ...data, $error: `wake-agent: needs a ${trigger.collection} record id` }
        }
      const out = await queueWakeUp(trigger, {
        collection,
        item,
        event: 'flow',
        origin: 'machine',
        actor: ctx.userId ?? null
      })
      const d = out.delivery
      return {
        status: out.skipped || !d || d.status === 'dead' ? 'reject' : 'resolve',
        output: {
          ...data,
          $agent: {
            delivery_id: d?.delivery_key ?? null,
            status: d?.status ?? null,
            skipped: out.skipped ?? null
          }
        }
      }
    }
  })
}
