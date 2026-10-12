import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { getPlanStepKind, listPlanStepKinds } from './ai-plan-steps.js'
import { httpError, isAdmin, type PlanView, proposePlan } from './ai-plans.js'

/**
 * PLAN TEMPLATES (#1952) — ready-made plans for common chores. A template
 * is a plan with BLANKS: the person fills them in, the blanks are put into
 * the steps, and the result goes through the normal propose path — every
 * step built as the person, the usual preview and impact line (#1900),
 * nothing runs until they approve.
 *
 * Built-in templates are generic (any collection, any field). Administrators
 * add their own; those are rows in nivaro_ai_proposals with action_type
 * 'plan_template' (no table of their own — the single-proposal routes never
 * run them: status 'template' is never 'proposed').
 *
 * Placeholders in a template's steps:
 *   "{{key}}"          the whole value becomes the blank's value (typed)
 *   "text {{key}}"     put into the text
 *   "{{$ago:key}}"     the date `key` days before now (ISO)
 * Object KEYS may be placeholders too ({"{{status_field}}": {"_eq": …}}).
 * An object carrying "$if": "key" is dropped when that blank is empty (the
 * "$if" itself is removed otherwise) — optional filter parts.
 */

export const TEMPLATE_ACTION_TYPE = 'plan_template'
const TEMPLATE_STATUS = 'template'

export type BlankType = 'collection' | 'field' | 'text' | 'number' | 'person' | 'record' | 'value'

export interface PlanTemplateBlank {
  key: string
  label: string
  type: BlankType
  help?: string
  optional?: boolean
}

export interface PlanTemplate {
  key: string
  label: string
  description: string
  builtin: boolean
  blanks: PlanTemplateBlank[]
  /** The plan title, with placeholders. */
  title: string
  steps: Array<Record<string, unknown>>
}

const BLANK_TYPES = new Set<BlankType>([
  'collection',
  'field',
  'text',
  'number',
  'person',
  'record',
  'value'
])

export const BUILTIN_TEMPLATES: PlanTemplate[] = [
  {
    key: 'close-child-lines',
    label: "Close out a record's open lines",
    description:
      'Set every line under one record to a closed value — e.g. the open lines of an order.',
    builtin: true,
    blanks: [
      { key: 'lines', label: 'Lines collection', type: 'collection' },
      { key: 'parent_field', label: 'Field on a line that points to the record', type: 'field' },
      { key: 'parent_id', label: 'The record (id)', type: 'record' },
      { key: 'status_field', label: 'Status field on a line', type: 'field' },
      { key: 'closed_value', label: 'Closed value', type: 'value' }
    ],
    title: 'Close out the open lines of {{parent_id}}',
    steps: [
      {
        kind: 'bulk_update',
        title: 'Close the open lines',
        collection: '{{lines}}',
        filter: {
          _and: [
            { '{{parent_field}}': { _eq: '{{parent_id}}' } },
            // Null-safe: a line with no status yet is still open.
            {
              _or: [
                { '{{status_field}}': { _neq: '{{closed_value}}' } },
                { '{{status_field}}': { _null: true } }
              ]
            }
          ]
        },
        changes: { '{{status_field}}': '{{closed_value}}' }
      }
    ]
  },
  {
    key: 'reassign-leaver',
    label: "Reassign a leaver's open records",
    description:
      'Hand every record one person owns to someone else, and tell the new owner. Optionally only the records not yet closed.',
    builtin: true,
    blanks: [
      { key: 'collection', label: 'Collection', type: 'collection' },
      { key: 'owner_field', label: 'Owner field', type: 'field' },
      { key: 'from_person', label: 'From (the person leaving)', type: 'person' },
      { key: 'to_person', label: 'To', type: 'person' },
      { key: 'status_field', label: 'Status field', type: 'field', optional: true },
      {
        key: 'closed_value',
        label: 'Closed value (records in it are left alone)',
        type: 'value',
        optional: true
      }
    ],
    title: 'Reassign {{collection}} records from a leaver',
    steps: [
      {
        kind: 'bulk_update',
        title: 'Hand the records over',
        collection: '{{collection}}',
        filter: {
          _and: [
            { '{{owner_field}}': { _eq: '{{from_person}}' } },
            {
              $if: 'closed_value',
              _or: [
                { '{{status_field}}': { _neq: '{{closed_value}}' } },
                { '{{status_field}}': { _null: true } }
              ]
            }
          ]
        },
        changes: { '{{owner_field}}': '{{to_person}}' }
      },
      {
        kind: 'send_message',
        title: 'Tell the new owner',
        to: ['{{to_person}}'],
        subject: '{{collection}} records handed to you',
        message:
          'Open {{collection}} records were reassigned to you from a colleague who is leaving. They are in your lists now.'
      }
    ]
  },
  {
    key: 'old-drafts',
    label: 'Move old drafts to a status',
    description:
      'Records still in one status after N days move to another (e.g. Draft → Canceled).',
    builtin: true,
    blanks: [
      { key: 'collection', label: 'Collection', type: 'collection' },
      { key: 'status_field', label: 'Status field', type: 'field' },
      { key: 'from_value', label: 'Current status (e.g. Draft)', type: 'value' },
      { key: 'date_field', label: 'Date field to age by', type: 'field' },
      { key: 'days', label: 'Older than (days)', type: 'number' },
      { key: 'to_value', label: 'Move to (e.g. Canceled)', type: 'value' }
    ],
    title: 'Move {{from_value}} {{collection}} older than {{days}} days to {{to_value}}',
    steps: [
      {
        kind: 'bulk_update',
        title: 'Move the old records',
        collection: '{{collection}}',
        filter: {
          '{{status_field}}': { _eq: '{{from_value}}' },
          '{{date_field}}': { _lt: '{{$ago:days}}' }
        },
        changes: { '{{status_field}}': '{{to_value}}' }
      }
    ]
  },
  {
    key: 'tell-owners',
    label: 'Tell the owners of matching records',
    description: 'Message the current owners of every record where a field has a value.',
    builtin: true,
    blanks: [
      { key: 'collection', label: 'Collection', type: 'collection' },
      { key: 'field', label: 'Field', type: 'field' },
      { key: 'value', label: 'Value', type: 'value' },
      { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'message', label: 'Message', type: 'text' }
    ],
    title: 'Tell the owners of {{collection}} where {{field}} is {{value}}',
    steps: [
      {
        kind: 'send_message',
        subject: '{{subject}}',
        message: '{{message}}',
        owners_of: { collection: '{{collection}}', filter: { '{{field}}': { _eq: '{{value}}' } } }
      }
    ]
  }
]

const PLACEHOLDER = /\{\{\s*(\$ago:)?([a-z][a-z0-9_]*)\s*\}\}/gi
const WHOLE = /^\{\{\s*(\$ago:)?([a-z][a-z0-9_]*)\s*\}\}$/i

function agoIso(days: unknown, now: Date): string {
  const n = Number(days)
  if (!Number.isFinite(n) || n < 0) throw httpError('A number of days must be 0 or more', 400)
  return new Date(now.getTime() - n * 86_400_000).toISOString()
}

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '')
}

/** Put the blanks into a template's steps (pure — exported for tests). */
export function fillTemplate(
  node: unknown,
  values: Record<string, unknown>,
  now = new Date()
): unknown {
  if (typeof node === 'string') {
    const whole = node.match(WHOLE)
    if (whole) {
      const v = values[whole[2]]
      return whole[1] ? agoIso(v, now) : (v ?? null)
    }
    return node.replace(PLACEHOLDER, (_m, ago: string | undefined, key: string) =>
      ago ? agoIso(values[key], now) : isEmpty(values[key]) ? '' : String(values[key])
    )
  }
  if (Array.isArray(node)) {
    return node
      .filter(
        (x) =>
          !(
            x &&
            typeof x === 'object' &&
            '$if' in x &&
            isEmpty(values[String((x as Record<string, unknown>).$if)])
          )
      )
      .map((x) => fillTemplate(x, values, now))
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$if') continue
      if (v && typeof v === 'object' && !Array.isArray(v) && '$if' in v) {
        if (isEmpty(values[String((v as Record<string, unknown>).$if)])) continue
      }
      const key = String(fillTemplate(k, values, now))
      if (!key) continue
      out[key] = fillTemplate(v, values, now)
    }
    return out
  }
  return node
}

function parseTemplateRow(row: Record<string, unknown>): PlanTemplate | null {
  try {
    const t = JSON.parse(String(row.payload)) as Partial<PlanTemplate>
    return {
      key: `custom:${String(row.id)}`,
      label: String(t.label ?? 'Template'),
      description: String(t.description ?? ''),
      builtin: false,
      blanks: Array.isArray(t.blanks) ? t.blanks : [],
      title: String(t.title ?? t.label ?? 'Plan'),
      steps: Array.isArray(t.steps) ? t.steps : []
    }
  } catch {
    return null
  }
}

export async function listTemplates(): Promise<PlanTemplate[]> {
  const rows = (await db('nivaro_ai_proposals')
    .where({ action_type: TEMPLATE_ACTION_TYPE, status: TEMPLATE_STATUS })
    .orderBy('created_at', 'asc')
    .select('id', 'payload')) as Array<Record<string, unknown>>
  return [
    ...BUILTIN_TEMPLATES,
    ...rows.map(parseTemplateRow).filter((t): t is PlanTemplate => t !== null)
  ]
}

async function findTemplate(key: string): Promise<PlanTemplate> {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.key === key)
  if (builtin) return builtin
  const m = /^custom:([0-9a-fA-F-]{36})$/.exec(key)
  if (m) {
    const row = (await db('nivaro_ai_proposals')
      .where({ id: m[1], action_type: TEMPLATE_ACTION_TYPE, status: TEMPLATE_STATUS })
      .first('id', 'payload')) as Record<string, unknown> | undefined
    const t = row ? parseTemplateRow(row) : null
    if (t) return t
  }
  throw httpError('Template not found', 404)
}

/** Check + type the person's answers to a template's blanks. */
async function readBlanks(
  t: PlanTemplate,
  raw: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {}
  for (const b of t.blanks) {
    const v = raw[b.key]
    if (isEmpty(v)) {
      if (!b.optional) throw httpError(`Fill in “${b.label}”`, 400)
      values[b.key] = null
      continue
    }
    const text = String(v).trim().slice(0, 500)
    switch (b.type) {
      case 'collection':
        if (!/^[A-Za-z0-9_]+$/.test(text) || /^(nivaro|directus)_/i.test(text))
          throw httpError(`“${b.label}” is not a collection`, 400)
        values[b.key] = text
        break
      case 'field':
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text))
          throw httpError(`“${b.label}” is not a field`, 400)
        values[b.key] = text
        break
      case 'number': {
        const n = Number(text)
        if (!Number.isFinite(n)) throw httpError(`“${b.label}” must be a number`, 400)
        values[b.key] = n
        break
      }
      case 'person': {
        const { findPerson } = await import('./ai-actions.js')
        try {
          values[b.key] = (await findPerson(text)).id
        } catch (err) {
          throw httpError(`“${b.label}”: ${(err as Error).message}`, 400)
        }
        break
      }
      default:
        values[b.key] = text
    }
  }
  return values
}

/** Fill a template and propose it as a plan — AS THE PERSON (every step's
 *  own access checks apply; nothing runs until they approve). */
export async function proposeFromTemplate(
  user: User,
  key: string,
  raw: Record<string, unknown>
): Promise<PlanView> {
  const t = await findTemplate(key)
  const values = await readBlanks(t, raw ?? {})
  const steps = fillTemplate(t.steps, values) as Array<Record<string, unknown>>
  const title = String(fillTemplate(t.title, values)).slice(0, 200)
  return proposePlan(user, { title, steps }, { template: { key: t.key, label: t.label } })
}

export interface TemplateInput {
  label?: unknown
  description?: unknown
  title?: unknown
  blanks?: unknown
  steps?: unknown
}

function validateTemplate(input: TemplateInput): Omit<PlanTemplate, 'key' | 'builtin'> {
  const label = String(input.label ?? '')
    .trim()
    .slice(0, 120)
  if (!label) throw httpError('A template needs a name', 400)
  const blanks: PlanTemplateBlank[] = []
  for (const b of Array.isArray(input.blanks) ? input.blanks : []) {
    const r = (b ?? {}) as Record<string, unknown>
    const key = String(r.key ?? '')
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key))
      throw httpError(`Blank key "${key}" must be lowercase letters, digits and _`, 400)
    const type = String(r.type ?? 'text') as BlankType
    if (!BLANK_TYPES.has(type)) throw httpError(`Blank "${key}" has an unknown type`, 400)
    blanks.push({
      key,
      label: String(r.label ?? key).slice(0, 120),
      type,
      ...(r.help ? { help: String(r.help).slice(0, 300) } : {}),
      ...(r.optional ? { optional: true } : {})
    })
  }
  const steps = Array.isArray(input.steps) ? (input.steps as Array<Record<string, unknown>>) : []
  if (steps.length === 0 || steps.length > 20) throw httpError('A template needs 1–20 steps', 400)
  steps.forEach((s, i) => {
    const kind = String(s?.kind ?? '')
    if (!getPlanStepKind(kind)) {
      throw httpError(
        `Step ${i + 1}: unknown kind "${kind}" (one of ${listPlanStepKinds()
          .map((k) => k.kind)
          .join(', ')})`,
        400
      )
    }
  })
  return {
    label,
    description: String(input.description ?? '').slice(0, 500),
    title: String(input.title ?? label).slice(0, 200),
    blanks,
    steps
  }
}

async function assertAdmin(user: User): Promise<void> {
  if (!(await isAdmin(user))) throw httpError('Only administrators can manage plan templates', 403)
}

export async function createTemplate(admin: User, input: TemplateInput): Promise<PlanTemplate> {
  await assertAdmin(admin)
  const t = validateTemplate(input)
  const id = randomUUID()
  await db('nivaro_ai_proposals').insert({
    id,
    user: admin.id,
    action_type: TEMPLATE_ACTION_TYPE,
    collection: '__plan__',
    payload: JSON.stringify(t),
    preview: JSON.stringify({ title: t.label }),
    status: TEMPLATE_STATUS,
    created_at: new Date()
  })
  await logActivity({ action: 'ai-plan-template', user: admin.id, comment: `created “${t.label}”` })
  return { key: `custom:${id}`, builtin: false, ...t }
}

function customId(key: string): string {
  const m = /^custom:([0-9a-fA-F-]{36})$/.exec(key)
  if (!m) throw httpError('Built-in templates cannot be changed', 400)
  return m[1]
}

export async function updateTemplate(
  admin: User,
  key: string,
  input: TemplateInput
): Promise<PlanTemplate> {
  await assertAdmin(admin)
  const id = customId(key)
  const t = validateTemplate(input)
  const n = await db('nivaro_ai_proposals')
    .where({ id, action_type: TEMPLATE_ACTION_TYPE, status: TEMPLATE_STATUS })
    .update({ payload: JSON.stringify(t), preview: JSON.stringify({ title: t.label }) })
  if (Number(n) !== 1) throw httpError('Template not found', 404)
  await logActivity({ action: 'ai-plan-template', user: admin.id, comment: `updated “${t.label}”` })
  return { key, builtin: false, ...t }
}

export async function deleteTemplate(admin: User, key: string): Promise<void> {
  await assertAdmin(admin)
  const id = customId(key)
  const n = await db('nivaro_ai_proposals')
    .where({ id, action_type: TEMPLATE_ACTION_TYPE, status: TEMPLATE_STATUS })
    .delete()
  if (Number(n) !== 1) throw httpError('Template not found', 404)
  await logActivity({ action: 'ai-plan-template', user: admin.id, comment: `deleted ${key}` })
}
