import type Anthropic from '@anthropic-ai/sdk'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { getAiClient, getAiModelSettings } from '../ai-client.js'
import { roleFieldAccess } from '../layout-field-access.js'
import { parseConditions, parseRecordConditions } from '../layout-patch.js'
import {
  collectionLabels,
  explainField,
  findRole,
  LayoutAssistError,
  whichForm
} from './layout-explain-field.js'
import {
  conditionWords,
  describeLayout,
  fieldLabel,
  lintFacts,
  loadLayoutFacts
} from './layout-facts.js'
import { cleanText } from './model.js'

/**
 * "Ask about this form" (#2695): an admin's question about the layouts of a
 * collection ("why can't Finance see Zone on record 284212?"), answered by the
 * chat model with READ-ONLY tools over the same engines the editor shows:
 * the resolver behind the overview's explain and Test a record, the role
 * field access behind "who sees this field" (#2580), the layout lint, and the
 * layout itself (the editor's draft when it sent one). No tool writes; no
 * record value reaches the model (a section rule comes back matched or not).
 */

export const ASK_TOOLS: Anthropic.Tool[] = [
  {
    name: 'which_form',
    description:
      'Which form (layout) a record opens with for a role, and why — the live resolver, with every candidate checked. Without a record: the form for new records / any record. Without a role: as an administrator.',
    input_schema: {
      type: 'object',
      properties: {
        record_id: { type: 'string', description: 'The record id, when the question names one' },
        role: { type: 'string', description: 'Role name or id, when the question names one' }
      }
    }
  },
  {
    name: 'explain_field',
    description:
      'Why a field is shown, hidden or read-only for a role on a record: role permissions, the form the role gets, where the field sits, and the form rules (hidden / read-only for roles, sections that show only when…).',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Field key or label' },
        role: { type: 'string' },
        record_id: { type: 'string' },
        layout_id: {
          type: 'number',
          description: 'Judge this form instead of the one the resolver picks'
        }
      },
      required: ['field']
    }
  },
  {
    name: 'describe_layout',
    description:
      'A form as an admin reads it: who gets it, its record rule, settings that are on, sections with their fields (width, required, read-only, hidden), rules per section, and collection fields that are not on it. Default: the form being edited.',
    input_schema: { type: 'object', properties: { layout_id: { type: 'number' } } }
  },
  {
    name: 'list_layouts',
    description: 'Every layout of the collection: id, name, kind, default, roles and record rule.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'role_access',
    description:
      "A role's field permissions on the collection: may it read / update records, which fields its permissions hide or make read-only.",
    input_schema: {
      type: 'object',
      properties: { role: { type: 'string' } },
      required: ['role']
    }
  },
  {
    name: 'lint_findings',
    description:
      'The layout checks for a form: required fields people cannot fill, unreachable steps and fields, empty sections, accessibility.',
    input_schema: { type: 'object', properties: { layout_id: { type: 'number' } } }
  }
]

const TOOL_NAMES = new Set(ASK_TOOLS.map((t) => t.name))
const MAX_ROUNDS = 6
const MAX_RESULT_CHARS = 14_000

export interface AskTurn {
  role: 'user' | 'assistant'
  content: string
}

export type AskCite =
  | { kind: 'field'; field: string; label: string }
  | { kind: 'record'; id: string }
  | { kind: 'layout'; id: number; name: string }

export interface AskAnswer {
  answer: string
  cites: AskCite[]
  tools: Array<{ tool: string; ok: boolean }>
  model: string | null
}

type Client = {
  messages: {
    create: (args: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>
  }
}

export interface AskContext {
  collection: string
  layoutId: number
  layoutName: string
  draft?: unknown
  asker: User
}

function systemPrompt(ctx: AskContext): string {
  return `You answer an administrator's questions about the forms (layouts) of the collection "${ctx.collection}" inside its layout editor. They are editing the form #${ctx.layoutId} "${ctx.layoutName}"${ctx.draft ? ' (tools read their unsaved draft of it)' : ''}.
Use the tools to look things up; never guess how a form or a permission behaves. Answer in plain text (no Markdown: no asterisks, headings or rules) in a few short sentences or a short "- " list, naming fields, sections, forms and roles by their labels. When something hides or locks a field, say exactly which rule does it and where an admin changes it: role permissions (Roles page), "Who gets this form" in Form settings, a section's "Hidden for roles" / "Read-only for roles" / "Shows when" in the section inspector, or the field's Look / Rules tabs in the inspector. You cannot change anything yourself. Say only what the tool results say: never invent record values or a record's state, and when a result does not say whether a rule applies to the record, say that it depends on it. Tool reasons name where each rule is edited; repeat that, not a guess.`
}

function resultText(v: unknown): string {
  const s = JSON.stringify(v)
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}…(cut)` : s
}

const str = (v: unknown) => (v == null || v === '' ? null : String(v).trim().slice(0, 80))

/** One tool call, as the admin. Collects what the answer can cite. */
export async function runAskTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AskContext,
  cites: Map<string, AskCite>
): Promise<unknown> {
  const layoutArg = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : ctx.layoutId
  }
  const sameCollection = async (id: number) => {
    const facts = await loadLayoutFacts(id, { draft: id === ctx.layoutId ? ctx.draft : undefined })
    if (!facts || String(facts.bundle.layout.collection) !== ctx.collection)
      throw new LayoutAssistError(404, `No layout #${id} on this collection`)
    cites.set(`layout:${id}`, {
      kind: 'layout',
      id,
      name: String(facts.bundle.layout.name ?? '')
    })
    return facts
  }
  const record = str(input.record_id)
  if (record) cites.set(`record:${record}`, { kind: 'record', id: record })
  switch (name) {
    case 'which_form': {
      const role = await findRole(str(input.role))
      const res = await whichForm({ collection: ctx.collection, item: record, role })
      if (res.layout)
        cites.set(`layout:${res.layout.id}`, {
          kind: 'layout',
          id: res.layout.id,
          name: res.layout.name
        })
      return res
    }
    case 'explain_field': {
      const lid = Number(input.layout_id)
      const res = await explainField({
        collection: ctx.collection,
        field: input.field,
        role: str(input.role),
        item: record,
        layoutId: Number.isFinite(lid) && lid > 0 ? lid : null,
        draft: ctx.draft,
        draftLayoutId: ctx.layoutId,
        asker: ctx.asker
      })
      cites.set(`field:${res.field}`, { kind: 'field', field: res.field, label: res.label })
      if (res.layout)
        cites.set(`layout:${res.layout.id}`, {
          kind: 'layout',
          id: res.layout.id,
          name: res.layout.name
        })
      return res
    }
    case 'describe_layout':
      return describeLayout(await sameCollection(layoutArg(input.layout_id)))
    case 'list_layouts': {
      const [rows, labels] = await Promise.all([
        db('nivaro_collection_layouts')
          .where({ collection: ctx.collection })
          .orderByRaw('is_active desc, sort asc, id asc')
          .limit(100)
          .select(
            'id',
            'name',
            'layout_type',
            'is_active',
            'slug',
            'conditions',
            'record_conditions'
          ) as Promise<Array<Record<string, unknown>>>,
        collectionLabels(ctx.collection)
      ])
      const roles = (await db('nivaro_roles').select('id', 'name')) as Array<{
        id: string
        name: string
      }>
      const roleName = new Map(roles.map((r) => [String(r.id).toUpperCase(), r.name]))
      return rows.map((r) => {
        const ids = (parseConditions(r.conditions)?.role_ids ?? []).map(String)
        const rules = parseRecordConditions(r.record_conditions) ?? []
        return {
          id: Number(r.id),
          name: String(r.name ?? ''),
          kind: String(r.layout_type ?? 'grouped'),
          default: !!r.is_active,
          slug: r.slug ?? null,
          roles: ids.map((id) => roleName.get(id.toUpperCase()) ?? id),
          record_rule: rules.length ? conditionWords(labels, rules) : null
        }
      })
    }
    case 'role_access': {
      const role = await findRole(str(input.role))
      if (!role) throw new LayoutAssistError(400, 'Name a role')
      if (role.admin)
        return { role: role.name, admin: true, note: 'Administrators see every field.' }
      const labels = await collectionLabels(ctx.collection)
      const all = labels.ctx.fields.map((f) => f.field)
      const access = await roleFieldAccess(ctx.collection, role, all)
      const named = (list: string[]) =>
        list.slice(0, 80).map((f) => `${fieldLabel(labels, f)} (${f})`)
      return {
        role: role.name,
        can_read: access.can_read,
        can_update: access.can_update,
        hidden_fields: named(access.hidden_fields),
        readonly_fields: named(access.readonly_fields)
      }
    }
    case 'lint_findings': {
      const facts = await sameCollection(layoutArg(input.layout_id))
      return lintFacts(facts)
        .slice(0, 40)
        .map((f) => ({ severity: f.severity, rule: f.rule, message: f.message }))
    }
    default:
      throw new LayoutAssistError(400, `Unknown tool ${name}`)
  }
}

export async function askAboutLayout(
  question: string,
  ctx: AskContext,
  opts: { history?: AskTurn[]; client?: Client | null } = {}
): Promise<AskAnswer> {
  const q = cleanText(question, 1000)
  if (!q || q.length < 3) throw new LayoutAssistError(400, 'Ask a question about this form')
  const model = (await getAiModelSettings()).chatModel
  const client =
    opts.client === undefined ? ((await getAiClient({ model })) as Client | null) : opts.client
  if (!client)
    throw new LayoutAssistError(
      503,
      'AI is not configured — set it up under Settings → AI Features'
    )
  const convo: Anthropic.MessageParam[] = [
    ...(opts.history ?? [])
      .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
      .slice(-6)
      .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) })),
    { role: 'user', content: q }
  ]
  const cites = new Map<string, AskCite>()
  const tools: AskAnswer['tools'] = []
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let res: Anthropic.Message
    try {
      res = await client.messages.create({
        model,
        max_tokens: 1200,
        system: systemPrompt(ctx),
        tools: ASK_TOOLS,
        messages: convo
      })
    } catch (err) {
      throw new LayoutAssistError(
        502,
        `The AI could not answer: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400)
      )
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (res.stop_reason !== 'tool_use') {
      return {
        answer: text || 'I could not find an answer to that.',
        cites: [...cites.values()].slice(0, 20),
        tools,
        model
      }
    }
    convo.push({ role: 'assistant', content: res.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue
      try {
        if (!TOOL_NAMES.has(block.name))
          throw new LayoutAssistError(400, `Unknown tool ${block.name}`)
        const out = await runAskTool(
          block.name,
          (block.input ?? {}) as Record<string, unknown>,
          ctx,
          cites
        )
        results.push({ type: 'tool_result', tool_use_id: block.id, content: resultText(out) })
        tools.push({ tool: block.name, ok: true })
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: (err instanceof Error ? err.message : 'failed').slice(0, 400),
          is_error: true
        })
        tools.push({ tool: block.name, ok: false })
      }
    }
    convo.push({ role: 'user', content: results })
  }
  return {
    answer: 'That needed more lookups than I allow for one question. Ask something narrower.',
    cites: [...cites.values()].slice(0, 20),
    tools,
    model
  }
}
