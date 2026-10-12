import type { PlanStepDef } from './ai-plan-runner.js'

/**
 * A plan's IMPACT line (#1900) — "Touches 34 records in 3 collections,
 * messages 12 people, moves 5 records to Approved" — read straight off the
 * steps' previews. Pure: every preview was built AS THE PERSON when the plan
 * was proposed (only records they can read), so nothing here reads data.
 */

export interface PlanImpact {
  /** Distinct existing records the plan writes to. */
  records: number
  collections: Array<{ collection: string; records: number }>
  created: number
  messages: number
  chat_posts: number
  flows: number
  tasks: number
  dashboards: number
  /** A status-like field set to one value — "moves 5 records to Approved". */
  moves: Array<{ collection: string; field: string; value: string; records: number }>
  summary: string
}

/** A field whose value reads as where a record is, not what it holds. */
const STATUS_FIELD = /(^|_)(status|state|stage|phase)$/i

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

function shown(v: unknown): string {
  if (v == null || v === '') return 'blank'
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

export function planImpact(steps: PlanStepDef[]): PlanImpact {
  const touched = new Map<string, Set<string>>()
  const counted = new Map<string, number>()
  const moves: PlanImpact['moves'] = []
  const out = { created: 0, messages: 0, chat_posts: 0, flows: 0, tasks: 0, dashboards: 0 }
  const touch = (collection: string, ids: string[] | null, count: number) => {
    if (!collection) return
    if (ids && ids.length > 0) {
      const set = touched.get(collection) ?? new Set<string>()
      for (const id of ids) set.add(String(id))
      touched.set(collection, set)
    } else if (count > 0) {
      counted.set(collection, (counted.get(collection) ?? 0) + count)
    }
  }
  for (const step of [...steps].sort((a, b) => a.n - b.n)) {
    const p = step.preview ?? {}
    const count = Number(p.count ?? 0) || 0
    const collection = String(
      p.collection ?? step.targets?.collection ?? step.payload?.collection ?? ''
    )
    switch (step.kind) {
      case 'bulk_update':
      case 'integrity_fix': {
        touch(collection, step.targets?.ids ?? null, count)
        if (step.kind === 'bulk_update') {
          const changes = (p.changes ?? {}) as Record<string, unknown>
          for (const [field, value] of Object.entries(changes)) {
            if (STATUS_FIELD.test(field))
              moves.push({ collection, field, value: shown(value), records: count })
          }
        }
        break
      }
      case 'create_record':
        out.created += 1
        break
      case 'create_task':
        out.tasks += 1
        break
      case 'create_dashboard':
        out.dashboards += 1
        break
      case 'send_message':
        out.messages += count
        break
      case 'post_chat':
        out.chat_posts += 1
        break
      case 'run_flow':
        out.flows += 1
        break
      default:
        // A kind registered later still counts the records it targets.
        if (step.targets) touch(step.targets.collection, step.targets.ids, count)
    }
  }
  const collections = [...new Set([...touched.keys(), ...counted.keys()])]
    .map((c) => ({ collection: c, records: (touched.get(c)?.size ?? 0) + (counted.get(c) ?? 0) }))
    .sort((a, b) => b.records - a.records || a.collection.localeCompare(b.collection))
  const records = collections.reduce((n, c) => n + c.records, 0)

  const parts: string[] = []
  if (records > 0) {
    parts.push(
      collections.length === 1
        ? `touches ${plural(records, `${collections[0].collection} record`)}`
        : `touches ${plural(records, 'record')} in ${collections.length} collections`
    )
  }
  if (out.created) parts.push(`creates ${plural(out.created, 'record')}`)
  if (out.tasks) parts.push(`creates ${plural(out.tasks, 'task')}`)
  if (out.messages) parts.push(`messages ${plural(out.messages, 'person', 'people')}`)
  if (out.chat_posts) parts.push(`posts ${plural(out.chat_posts, 'chat message')}`)
  if (out.flows) parts.push(`runs ${plural(out.flows, 'flow')}`)
  if (out.dashboards) parts.push(`creates ${plural(out.dashboards, 'dashboard')}`)
  for (const m of moves) parts.push(`moves ${plural(m.records, 'record')} to ${m.value}`)
  const summary = parts.length
    ? `${parts[0].charAt(0).toUpperCase()}${parts[0].slice(1)}${parts.length > 1 ? `, ${parts.slice(1).join(', ')}` : ''}`
    : 'Changes nothing that can be counted in advance'
  return { records, collections, ...out, moves, summary }
}
