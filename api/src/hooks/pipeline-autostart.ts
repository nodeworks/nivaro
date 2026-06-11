import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { hooks } from './registry.js'

function coerceBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  if (typeof val === 'string') return val === '1' || val === 'true'
  return false
}

export function registerPipelineAutostartHooks() {
  hooks.after('*', 'create', async (ctx) => {
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

      await db('nivaro_workflow_history').insert({
        instance: instanceId,
        transition: null,
        from_state: null,
        to_state: startState.id,
        user: ctx.user ?? null,
        comment: 'Auto-started',
        timestamp: now
      })

      // Write state_field if configured
      if (binding.state_field && startState.key) {
        await db(ctx.collection)
          .where({ id: item })
          .update({ [binding.state_field]: startState.key })
          .catch(() => {})
      }
    } catch {
      // Non-fatal — never block item creation
    }
  })
}
