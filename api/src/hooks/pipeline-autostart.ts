import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { writeStartHistory } from '../services/instance-start.js'
import { deferEffect } from '../services/unit-of-work.js'
import { hooks } from './registry.js'

function coerceBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  if (typeof val === 'string') return val === '1' || val === 'true'
  return false
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
        let startState = binding.auto_start_state
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
      } catch {
        // Non-fatal — never block item creation
      }
    })
  )
}
