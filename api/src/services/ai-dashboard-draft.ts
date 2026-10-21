import { db } from '../db/index.js'
import type { User } from '../types.js'
import type { DashboardDraftWidget } from './ai-actions.js'
import { readableFieldSet } from './ai-aggregate-guard.js'
import { can } from './permissions.js'

/**
 * Draft a dashboard from a description (#2736). "A dashboard for invoice
 * reviewers: what's waiting, how old, by vendor" becomes a PROPOSED set of
 * widgets on the 4-column dashboard grid:
 *  - the model only ever sees collections, fields and saved queries the
 *    requester can read / run (the catalogue is built AS THEM);
 *  - every widget is then validated as them (create_dashboard in
 *    ai-actions.ts: read access, readable field and filter fields, an Ask AI
 *    query that runs for them) and placed by dashboard-grid-pack.ts;
 *  - the draft is an AI PLAN (one create_dashboard step, source
 *    'dashboard-draft'), so nothing is saved until the requester runs it,
 *    it expires like any plan, and it lands in AI plan history;
 *  - the preview computes every widget AS THE REQUESTER (computeWidgetData,
 *    the function every dashboard read uses), from the plan they own.
 */

export const DRAFT_SOURCE = { kind: 'dashboard-draft', label: 'Dashboard from a description' }
const MAX_COLLECTIONS = 60
const MAX_FIELDS = 24
const CATALOGUE_TYPES = new Set([
  'integer',
  'bigInteger',
  'decimal',
  'float',
  'number',
  'string',
  'boolean',
  'date',
  'datetime',
  'timestamp'
])

export interface DraftCatalogue {
  collections: Array<{ collection: string; fields: Array<{ field: string; type: string }> }>
  savedQueries: string[]
}

/** What the requester can read: collections + readable fields, and the saved queries they may run. */
export async function draftCatalogue(user: User): Promise<DraftCatalogue> {
  const cols = (await db('nivaro_collections')
    .whereNot('collection', 'like', 'nivaro%')
    .whereNot('collection', 'like', 'directus%')
    .whereNot('collection', 'like', 'zz%')
    .whereNot('collection', 'like', 'staging%')
    .select('collection', 'hidden')
    .orderBy('collection')) as Array<{ collection: string; hidden: unknown }>
  const readable: string[] = []
  for (const c of cols) {
    if (c.hidden === true || c.hidden === 1) continue
    if (await can(user, 'read', c.collection).catch(() => false)) readable.push(c.collection)
    if (readable.length >= MAX_COLLECTIONS) break
  }
  const fields = readable.length
    ? ((await db('nivaro_fields')
        .whereIn('collection', readable)
        .select('collection', 'field', 'type')) as Array<{
        collection: string
        field: string
        type: string
      }>)
    : []
  const collections: DraftCatalogue['collections'] = []
  for (const collection of readable) {
    const own = fields.filter((f) => f.collection === collection && CATALOGUE_TYPES.has(f.type))
    const ok = await readableFieldSet(user, collection, new Set(own.map((f) => f.field)))
    collections.push({
      collection,
      fields: own.filter((f) => ok.has(f.field)).slice(0, MAX_FIELDS)
    })
  }
  const { savedQueryCatalogue } = await import('./ai-chat.js')
  const savedQueries = await savedQueryCatalogue(user).catch(() => [] as string[])
  return { collections, savedQueries }
}

export function draftSystemPrompt(cat: DraftCatalogue): string {
  const catalogue = cat.collections
    .map((c) => `${c.collection}: ${c.fields.map((f) => `${f.field}(${f.type})`).join(', ')}`)
    .join('\n')
  return `You draft dashboards. Pick 3-8 widgets that answer the description, in reading order (the most important first).
Widget types:
- count: number of records (collection, optional filters)
- sum / avg: of a numeric field (collection, field, optional filters)
- latest: newest records (collection, field = comma list of up to 6 columns to show)
- line_chart / bar_chart: records created per day over the last 30 days (collection, field = any field)
- ai_query: a breakdown chart. query = {"tool":"aggregate","input":{"collection","op":"count|sum|avg|min|max","field"?,"group_by","filter"?}} for "by vendor"/"by status" breakdowns, or {"tool":"run_custom_query","input":{"slug","params"?}} for a saved query below. chart = bar | line | pie.
filters (count/sum/avg/latest): [{"field","op":"eq|neq|gt|gte|lt|lte|contains|in","value"}]. ai_query filter: {"field":{"_eq":value}} (ops _eq,_neq,_gt,_gte,_lt,_lte,_in,_null,_nnull).
Collections and fields you may use (nothing else exists for this person):
${catalogue || '(none)'}
Saved queries you may use with ai_query run_custom_query:
${cat.savedQueries.length ? cat.savedQueries.join('\n') : '(none)'}
Respond ONLY with JSON: {"name":"…","widgets":[{"type":"count","title":"…","collection":"…","field":null,"filters":[]},{"type":"ai_query","title":"…","chart":"bar","query":{"tool":"aggregate","input":{"collection":"…","op":"count","group_by":"…"}}}]}. Short plain titles. Use ONLY the listed collections, fields and saved queries.`
}

/** The draft the model returned, as a create_dashboard input (unvalidated). */
export function parseDraft(text: string): { name: string; widgets: DashboardDraftWidget[] } | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const raw = JSON.parse(m[0]) as { name?: unknown; widgets?: unknown }
    const widgets = Array.isArray(raw.widgets)
      ? (raw.widgets.filter(
          (w) => w && typeof w === 'object' && !Array.isArray(w)
        ) as DashboardDraftWidget[])
      : []
    if (!widgets.length) return null
    const name =
      String(raw.name ?? '')
        .trim()
        .slice(0, 200) || 'Drafted dashboard'
    return { name, widgets: widgets.slice(0, 12) }
  } catch {
    return null
  }
}

/**
 * Validate the drafted widgets one by one as the requester and keep the ones
 * that pass (a draft is a proposal — one widget naming a field they cannot
 * read is dropped with its reason, not the whole draft).
 */
export async function keepValidWidgets(
  user: User,
  widgets: DashboardDraftWidget[]
): Promise<{ kept: DashboardDraftWidget[]; dropped: Array<{ title: string; reason: string }> }> {
  const { buildAction } = await import('./ai-actions.js')
  const kept: DashboardDraftWidget[] = []
  const dropped: Array<{ title: string; reason: string }> = []
  for (const w of widgets) {
    try {
      await buildAction(user, {
        action_type: 'create_dashboard',
        dashboard: { name: 'check', widgets: [w] }
      })
      kept.push(w)
    } catch (err) {
      dropped.push({
        title: String(w.title ?? w.type ?? 'Widget').slice(0, 100),
        reason: (err instanceof Error ? err.message : 'invalid').slice(0, 200)
      })
    }
  }
  return { kept, dropped }
}

export interface DraftResult {
  plan: import('./ai-plans.js').PlanView
  dropped: Array<{ title: string; reason: string }>
}

export class DraftError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message)
  }
}

/** Ask the model, validate as the requester, store the draft as a plan. Nothing else is written. */
export async function draftDashboard(user: User, description: string): Promise<DraftResult> {
  const prompt = description.trim().slice(0, 2000)
  if (!prompt) throw new DraftError('Describe the dashboard you want', 400)
  const { getAiClient, getAiModelSettings } = await import('./ai-client.js')
  const { generateModel } = await getAiModelSettings()
  const client = await getAiClient({ model: generateModel })
  if (!client) throw new DraftError('AI features are not configured', 503)
  const cat = await draftCatalogue(user)
  if (!cat.collections.length && !cat.savedQueries.length)
    throw new DraftError('There is nothing you can read to build a dashboard from', 422)

  let draft: ReturnType<typeof parseDraft> = null
  try {
    const msg = await client.messages.create({
      model: generateModel,
      max_tokens: 2000,
      system: draftSystemPrompt(cat),
      messages: [{ role: 'user', content: prompt }]
    })
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    draft = parseDraft(text)
  } catch (err) {
    throw new DraftError(err instanceof Error ? err.message.slice(0, 200) : 'AI call failed', 502)
  }
  if (!draft)
    throw new DraftError('The AI returned no widgets — try describing it differently', 422)
  const { proposePlan } = await import('./ai-plans.js')
  const { name } = draft
  const propose = (widgets: DashboardDraftWidget[]) =>
    proposePlan(
      user,
      {
        title: `Dashboard: ${name}`,
        steps: [
          {
            kind: 'create_dashboard',
            title: `Create dashboard “${name}”`,
            dashboard: { name, widgets },
            // Kept for the plan history: what was asked for.
            description: prompt
          }
        ]
      },
      { source: { ...DRAFT_SOURCE } }
    )
  try {
    // The common case: every widget builds as the requester.
    return { plan: await propose(draft.widgets), dropped: [] }
  } catch {
    // One bad widget (a field they cannot read, a query that fails) drops
    // with its reason instead of sinking the whole draft.
  }
  const { kept, dropped } = await keepValidWidgets(user, draft.widgets)
  if (!kept.length) {
    throw new DraftError(
      `None of the drafted widgets could be built from what you can read${dropped[0] ? ` (${dropped[0].reason})` : ''}`,
      422
    )
  }
  return { plan: await propose(kept), dropped }
}

export interface DraftPreviewWidget {
  type: string
  title: string
  collection: string | null
  field: string | null
  col: number
  row: number
  width: number
  height: number
  /** The widget's figures as the requester sees them. */
  data?: unknown
  error?: string
  /** An ai_query widget's source question / title. */
  question?: string | null
}

/** The draft's widgets, each computed as `user`, from a plan they own. */
export async function previewDraft(
  user: User,
  planId: string
): Promise<{ name: string; status: string; widgets: DraftPreviewWidget[] }> {
  const { assertOwner, loadPlan } = await import('./ai-plans.js')
  const { row, doc } = await loadPlan(planId)
  assertOwner(row, user)
  const step = doc.steps.find((s) => s.kind === 'create_dashboard')
  if (!step || doc.source?.kind !== DRAFT_SOURCE.kind)
    throw new DraftError('Not a dashboard draft', 404)
  const payload = step.payload as {
    name?: string
    widgets?: Array<{
      type: string
      title: string
      collection: string | null
      field: string | null
      filters: string | null
      col: number
      row: number
      width: number
      height: number
    }>
  }
  const { computeWidgetData } = await import('./dashboard-widgets.js')
  const widgets: DraftPreviewWidget[] = []
  for (const w of payload.widgets ?? []) {
    const out: DraftPreviewWidget = {
      type: w.type,
      title: w.title,
      collection: w.collection,
      field: w.field,
      col: w.col,
      row: w.row,
      width: w.width,
      height: w.height
    }
    const res = await computeWidgetData(
      { type: w.type, collection: w.collection, field: w.field, filters: w.filters },
      [],
      { user }
    ).catch(() => ({ error: 'Failed to compute', status: 500 }))
    if ('error' in res) out.error = res.error
    else out.data = res.data
    widgets.push(out)
  }
  return { name: String(payload.name ?? doc.title), status: String(row.status), widgets }
}
