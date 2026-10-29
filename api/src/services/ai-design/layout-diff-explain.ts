import { db } from '../../db/index.js'
import { getAiClient, getAiModelSettings } from '../ai-client.js'
import { loadLayoutBundle } from '../layout-ops.js'
import { UNGROUPED_KEY } from '../layout-ops-apply.js'
import { parseConditions, parseRecordConditions } from '../layout-patch.js'
import { collectionLabels } from './layout-explain-field.js'
import {
  conditionWords,
  draftBundleOf,
  fieldLabel,
  jsonList,
  overridesOf,
  roleIdsOf,
  roleNamesOf,
  widthWords
} from './layout-facts.js'
import { type AiComplete, asArray, cleanText, parseJsonLoose, titleCase } from './model.js'

/**
 * Why two forms differ (#2693): the structural difference between two layout
 * states — two layouts (Compare two forms #2659, Merge two forms #2661) or
 * two versions of one (History compare) — as plain sentences, plus the
 * History notes that explain how each got there. With AI configured the
 * model condenses both into a short explanation; without it the sentences
 * stand alone. Only layout config and notes go to the model.
 */

type Obj = Record<string, unknown>

export interface DiffSideInput {
  layout_id: number
  /** A saved version id, 'newest', or omitted for the layout as it is now. */
  version?: number | 'newest' | null
}

interface SideGroup {
  key: string
  label: string
  type: string
  parent: string | null
  collapsed: boolean
  visible_when: unknown[]
  hidden_for: string[]
  locked_for: string[]
}
interface SidePlacement {
  field: string
  group: string
  label: string | null
  width: number | null
  required: boolean
  readonly: boolean
  hidden: boolean
  /** The placement's other own settings (help text, interface options, …) as JSON. */
  other: Record<string, unknown>
}
interface Side {
  layoutId: number
  title: string
  name: string
  version: number | null
  createdAt: string | null
  layout: Obj
  groups: SideGroup[]
  placements: SidePlacement[]
}

function sideFromRows(
  layoutId: number,
  layout: Obj,
  groupRows: Obj[],
  placementRows: Obj[],
  parentKeyOf: (g: Obj) => string | null
): Omit<Side, 'title' | 'version' | 'createdAt'> {
  const groups: SideGroup[] = groupRows
    .filter((g) => String(g.key) !== UNGROUPED_KEY)
    .map((g) => ({
      key: String(g.key),
      label: String(g.label ?? '') || titleCase(String(g.key)),
      type: String(g.type ?? 'section'),
      parent: parentKeyOf(g),
      collapsed: !!g.is_collapsed,
      visible_when: jsonList(g.visible_when),
      hidden_for: roleIdsOf(g.hidden_for_roles),
      locked_for: roleIdsOf(g.locked_for_roles)
    }))
  const seen = new Set<string>()
  const placements: SidePlacement[] = []
  for (const p of placementRows) {
    const field = String(p.field)
    if (field.startsWith('__') || seen.has(field)) continue
    seen.add(field)
    const ov = overridesOf(p)
    const { label: _l, required: _r, readonly: _ro, hidden: _h, ...other } = ov
    placements.push({
      field,
      group: p.group_key == null ? UNGROUPED_KEY : String(p.group_key),
      label:
        (typeof ov.label === 'string' && ov.label.trim()) ||
        (typeof p.label_override === 'string' && p.label_override) ||
        null,
      width: p.col_span == null ? null : Number(p.col_span),
      required: ov.required === true,
      readonly: ov.readonly === true,
      hidden: ov.hidden === true || p.is_visible === false || p.is_visible === 0,
      other
    })
  }
  return { layoutId, name: String(layout.name ?? ''), layout, groups, placements }
}

async function loadSide(input: DiffSideInput, draft?: unknown): Promise<Side | null> {
  const id = Number(input.layout_id)
  if (!Number.isFinite(id)) return null
  if (input.version == null) {
    const bundle = draftBundleOf(draft, id) ?? (await loadLayoutBundle(db, id))
    if (!bundle) return null
    const s = sideFromRows(
      id,
      bundle.layout as Obj,
      bundle.groups as unknown as Obj[],
      bundle.placements as unknown as Obj[],
      (g) => (g.parent_key == null ? null : String(g.parent_key))
    )
    return { ...s, title: `“${s.name}”`, version: null, createdAt: null }
  }
  const q = db('nivaro_layout_versions').where({ layout_id: id })
  const row = (await (input.version === 'newest'
    ? q.orderBy('version', 'desc').first()
    : q.where({ id: Number(input.version) }).first())) as
    | { version: number; snapshot: string; created_at: Date | string | null }
    | undefined
  if (!row) return null
  let snap: { layout?: Obj; groups?: Obj[]; assignments?: Obj[] }
  try {
    snap = JSON.parse(row.snapshot)
  } catch {
    return null
  }
  const groupRows = snap.groups ?? []
  const keyById = new Map(groupRows.map((g) => [Number(g.id), String(g.key)]))
  const s = sideFromRows(id, snap.layout ?? {}, groupRows, snap.assignments ?? [], (g) =>
    g.container_id == null ? null : (keyById.get(Number(g.container_id)) ?? null)
  )
  return {
    ...s,
    title: `version ${row.version}`,
    version: Number(row.version),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
  }
}

/** Layout settings compared, with their plain names. Name, link, sort and ids are identity, not shape. */
const SETTING_NAMES: Array<[string, string]> = [
  ['layout_type', 'Kind of layout'],
  ['tab_mode', 'Loose tabs show as'],
  ['validate_before_next', 'Check each step before Next'],
  ['accordion_mode', 'One section open at a time'],
  ['summary_enabled', 'Summary side panel'],
  ['summary_hide_empty', 'Summary: hide empty fields'],
  ['disable_comments', 'Hide comments'],
  ['disable_tasks', 'Hide tasks'],
  ['disable_revisions', 'Hide revisions'],
  ['disable_clone', 'Hide Clone button'],
  ['disable_delete', 'Hide Delete button'],
  ['ai_enabled', 'AI buttons'],
  ['allow_schedule', 'Schedule button for everyone'],
  ['allow_disable_pickers', 'Hide from pickers button for everyone'],
  ['create_hidden', 'Hide from New menu'],
  ['create_label', 'New-menu label'],
  ['hide_integrity_banner', 'Hide data-integrity banner'],
  ['hide_sla_banner', 'Hide SLA banner'],
  ['changes_tray', 'Unsaved-changes tray'],
  ['dossier_enabled', 'Dossier button'],
  ['hide_empty', 'Hide empty values'],
  ['display_mode', 'Drill-down opens as'],
  ['sheet_width', 'Read view width'],
  ['pdf_theme', 'PDF theme'],
  ['parent_layout_id', 'Inherit from'],
  ['workflow_template_id', 'Addendum workflow']
]

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
function norm(v: unknown): string {
  if (v == null || v === '' || v === false || v === 0) return ''
  if (truthy(v)) return 'on'
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}
const listNames = (names: string[], max = 10) =>
  names.length <= max
    ? names.join(', ')
    : `${names.slice(0, max).join(', ')} and ${names.length - max} more`

export interface StructuralDiff {
  a: { layout_id: number; title: string; name: string; version: number | null }
  b: { layout_id: number; title: string; name: string; version: number | null }
  sentences: string[]
  counts: {
    only_a: number
    only_b: number
    moved: number
    changed: number
    sections: number
    settings: number
  }
}

export function diffSides(
  a: Side,
  b: Side,
  labels: Parameters<typeof conditionWords>[0] & Parameters<typeof roleNamesOf>[0]
): StructuralDiff {
  const sentences: string[] = []
  const A = a.title
  const B = b.title
  // Sections are matched by key, then by label (two forms cloned apart keep keys).
  const bByKey = new Map(b.groups.map((g) => [g.key, g]))
  const bByLabel = new Map(b.groups.map((g) => [g.label.toLowerCase(), g]))
  const match = new Map<string, SideGroup>()
  for (const g of a.groups) {
    const m = bByKey.get(g.key) ?? bByLabel.get(g.label.toLowerCase())
    if (m) match.set(g.key, m)
  }
  const matchedB = new Set([...match.values()].map((g) => g.key))
  const secName = (side: Side, key: string) =>
    key === UNGROUPED_KEY ? 'Ungrouped' : (side.groups.find((g) => g.key === key)?.label ?? key)
  const roleWords = (ids: string[]) => (ids.length ? roleNamesOf(labels, ids).join(', ') : 'nobody')

  // Layout settings.
  let settings = 0
  const rolesA = (parseConditions(a.layout.conditions)?.role_ids ?? []).map((r) =>
    String(r).toUpperCase()
  )
  const rolesB = (parseConditions(b.layout.conditions)?.role_ids ?? []).map((r) =>
    String(r).toUpperCase()
  )
  if ([...rolesA].sort().join() !== [...rolesB].sort().join()) {
    settings++
    sentences.push(
      `Who gets it: ${A} is for ${rolesA.length ? roleWords(rolesA) : 'every role'}; ${B} is for ${rolesB.length ? roleWords(rolesB) : 'every role'}.`
    )
  }
  const rulesA = parseRecordConditions(a.layout.record_conditions) ?? []
  const rulesB = parseRecordConditions(b.layout.record_conditions) ?? []
  if (JSON.stringify(rulesA) !== JSON.stringify(rulesB)) {
    settings++
    const w = (r: unknown[]) =>
      r.length ? `records where ${conditionWords(labels, r)}` : 'no record rule'
    sentences.push(`Record rule: ${A} has ${w(rulesA)}; ${B} has ${w(rulesB)}.`)
  }
  for (const [k, name] of SETTING_NAMES) {
    const x = norm(a.layout[k])
    const y = norm(b.layout[k])
    if (x === y) continue
    settings++
    const flag = x === 'on' || y === 'on'
    const say = (v: string) =>
      v === '' ? (flag ? 'off' : 'not set') : v === 'on' ? 'on' : `“${v.slice(0, 60)}”`
    sentences.push(`${name} — ${A}: ${say(x)}; ${B}: ${say(y)}.`)
  }

  // Sections.
  let sections = 0
  const onlyA = a.groups.filter((g) => !match.has(g.key))
  const onlyB = b.groups.filter((g) => !matchedB.has(g.key))
  if (onlyA.length) {
    sections += onlyA.length
    sentences.push(`Sections in ${A} only: ${listNames(onlyA.map((g) => g.label))}.`)
  }
  if (onlyB.length) {
    sections += onlyB.length
    sentences.push(`Sections in ${B} only: ${listNames(onlyB.map((g) => g.label))}.`)
  }
  /** "Zone — “A”: a third, required; “B”: half width, optional." */
  const contrast = (what: string, pa: string[], pb: string[]) =>
    `${what} — ${A}: ${pa.join(', ')}; ${B}: ${pb.join(', ')}.`
  const kindWord = (t: string) => (t === 'tab' ? 'a step' : `a ${t}`)
  const showsWhen = (r: unknown[]) =>
    r.length ? `shows when ${conditionWords(labels, r)}` : 'always shows'
  for (const g of a.groups) {
    const m = match.get(g.key)
    if (!m) continue
    const pa: string[] = []
    const pb: string[] = []
    const add = (x: string, y: string) => {
      pa.push(x)
      pb.push(y)
    }
    if (g.label !== m.label) add(`named “${g.label}”`, `named “${m.label}”`)
    if (g.type !== m.type) add(kindWord(g.type), kindWord(m.type))
    if (g.collapsed !== m.collapsed)
      add(
        g.collapsed ? 'starts collapsed' : 'starts open',
        m.collapsed ? 'starts collapsed' : 'starts open'
      )
    if ([...g.hidden_for].sort().join() !== [...m.hidden_for].sort().join())
      add(`hidden for ${roleWords(g.hidden_for)}`, `hidden for ${roleWords(m.hidden_for)}`)
    if ([...g.locked_for].sort().join() !== [...m.locked_for].sort().join())
      add(`read-only for ${roleWords(g.locked_for)}`, `read-only for ${roleWords(m.locked_for)}`)
    if (JSON.stringify(g.visible_when) !== JSON.stringify(m.visible_when))
      add(showsWhen(g.visible_when), showsWhen(m.visible_when))
    if (pa.length) {
      sections++
      sentences.push(contrast(`Section ${g.label}`, pa, pb))
    }
  }

  // Fields.
  const bp = new Map(b.placements.map((p) => [p.field, p]))
  const ap = new Map(a.placements.map((p) => [p.field, p]))
  const name = (f: string) => fieldLabel(labels, f)
  const fOnlyA = a.placements.filter((p) => !bp.has(p.field)).map((p) => name(p.field))
  const fOnlyB = b.placements.filter((p) => !ap.has(p.field)).map((p) => name(p.field))
  if (fOnlyA.length) sentences.push(`Fields in ${A} only: ${listNames(fOnlyA)}.`)
  if (fOnlyB.length) sentences.push(`Fields in ${B} only: ${listNames(fOnlyB)}.`)
  let moved = 0
  let changed = 0
  for (const p of a.placements) {
    const q = bp.get(p.field)
    if (!q) continue
    const pa: string[] = []
    const pb: string[] = []
    const add = (x: string, y: string) => {
      pa.push(x)
      pb.push(y)
    }
    const gA = secName(a, p.group)
    const gB = secName(b, q.group)
    const sameSection =
      match.get(p.group)?.key === q.group ||
      (p.group === UNGROUPED_KEY && q.group === UNGROUPED_KEY)
    const isMove = !sameSection && gA.toLowerCase() !== gB.toLowerCase()
    if (isMove) add(`in ${gA}`, `in ${gB}`)
    const flag = (k: 'required' | 'readonly' | 'hidden', on: string, off: string) => {
      if (p[k] !== q[k]) add(p[k] ? on : off, q[k] ? on : off)
    }
    flag('required', 'required', 'optional')
    flag('readonly', 'read-only', 'editable')
    flag('hidden', 'hidden', 'shown')
    if ((p.width ?? 12) !== (q.width ?? 12))
      add(widthWords(p.width) ?? 'default width', widthWords(q.width) ?? 'default width')
    if ((p.label ?? '') !== (q.label ?? ''))
      add(`labelled “${p.label ?? name(p.field)}”`, `labelled “${q.label ?? name(q.field)}”`)
    const otherKeys = [...new Set([...Object.keys(p.other), ...Object.keys(q.other)])].filter(
      (k) => JSON.stringify(p.other[k] ?? null) !== JSON.stringify(q.other[k] ?? null)
    )
    if (pa.length === 0 && otherKeys.length === 0) continue
    if (isMove) moved++
    if (pa.length > (isMove ? 1 : 0) || otherKeys.length) changed++
    if (pa.length) sentences.push(contrast(name(p.field), pa, pb))
    if (otherKeys.length)
      sentences.push(
        `${name(p.field)}: its own settings differ (${otherKeys
          .slice(0, 4)
          .map((k) => k.replace(/_/g, ' '))
          .join(', ')}).`
      )
  }
  return {
    a: { layout_id: a.layoutId, title: A, name: a.name, version: a.version },
    b: { layout_id: b.layoutId, title: B, name: b.name, version: b.version },
    sentences,
    counts: { only_a: fOnlyA.length, only_b: fOnlyB.length, moved, changed, sections, settings }
  }
}

export interface HistoryNote {
  layout_id: number
  version: number
  note: string
  at: string | null
  by: string | null
  /** Consecutive saves with this same note (newest shown). */
  times?: number
}

/** Notes of the saves that shaped each side, newest first. One layout: only the saves between the two. */
async function historyNotes(a: Side, b: Side): Promise<HistoryNote[]> {
  const ids = [...new Set([a.layoutId, b.layoutId])]
  let q = db('nivaro_layout_versions as v')
    .leftJoin('nivaro_users as u', 'u.id', 'v.created_by')
    .whereIn('v.layout_id', ids)
    .whereNotNull('v.note')
  if (ids.length === 1) {
    const lo = Math.min(a.version ?? Number.MAX_SAFE_INTEGER, b.version ?? Number.MAX_SAFE_INTEGER)
    const hi = Math.max(a.version ?? -1, b.version ?? -1)
    if (lo !== Number.MAX_SAFE_INTEGER) q = q.where('v.version', '>=', lo)
    if (a.version != null && b.version != null) q = q.where('v.version', '<', hi)
  }
  const rows = (await q
    .orderBy('v.version', 'desc')
    .limit(60)
    .select(
      'v.layout_id',
      'v.version',
      'v.note',
      'v.created_at',
      'u.first_name',
      'u.last_name'
    )) as Obj[]
  // A run of saves with the same note ("before assignments save" ×8) reads as one.
  const out: HistoryNote[] = []
  for (const r of rows) {
    const note = String(r.note ?? '').slice(0, 200)
    const last = out[out.length - 1]
    if (last && last.layout_id === Number(r.layout_id) && last.note === note) {
      last.times = (last.times ?? 1) + 1
      continue
    }
    out.push({
      layout_id: Number(r.layout_id),
      version: Number(r.version),
      note,
      at: r.created_at ? new Date(String(r.created_at)).toISOString() : null,
      by: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null
    })
  }
  return out
}

export const EXPLAIN_DIFF_SYSTEM = `You explain to an administrator, in plain words, how two versions of a data-entry form differ and how they got that way.
You get the two sides, the list of differences (already exact) and the History notes of the saves (newest first; a note names the edit the save was made before).
Answer with ONE JSON object and nothing else: {"summary":"<two or three sentences>","points":["<one short sentence>", ...]}.
Group related differences, say what each means for the people filling the form, and use the notes to say when or why a change happened when they show it. At most 8 points. Never invent a difference that is not in the list, and never guess why a change was made beyond what a note says.`

export function parseExplainAnswer(text: string): { summary: string | null; points: string[] } {
  const parsed = parseJsonLoose(text)
  if (!parsed) return { summary: cleanText(text, 600), points: [] }
  return {
    summary: cleanText(parsed.summary, 600),
    points: asArray(parsed.points)
      .map((p) => cleanText(p, 300))
      .filter((p): p is string => !!p)
      .slice(0, 8)
  }
}

async function generateComplete(): Promise<AiComplete | null> {
  const { generateModel } = await getAiModelSettings()
  const client = await getAiClient({ model: generateModel })
  if (!client) return null
  return async ({ system, user, maxTokens }) => {
    const msg = await client.messages.create({
      model: generateModel,
      max_tokens: maxTokens ?? 900,
      system,
      messages: [{ role: 'user', content: user }]
    })
    return msg.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('\n')
      .trim()
  }
}

export interface DiffExplanation extends StructuralDiff {
  notes: HistoryNote[]
  summary: string | null
  points: string[]
  ai_configured: boolean
  ai_error: string | null
}

export async function explainLayoutDiff(opts: {
  a: DiffSideInput
  b: DiffSideInput
  draft?: unknown
  ai?: boolean
  complete?: AiComplete | null
}): Promise<DiffExplanation | null> {
  const [a, b] = await Promise.all([loadSide(opts.a, opts.draft), loadSide(opts.b, opts.draft)])
  if (!a || !b) return null
  const collection = String(a.layout.collection ?? b.layout.collection ?? '')
  if (String(b.layout.collection ?? collection) !== collection) return null
  const labels = await collectionLabels(collection)
  const roles = (await db('nivaro_roles').select('id', 'name')) as Array<{
    id: string
    name: string
  }>
  const facts = {
    ...labels,
    roleNames: new Map(roles.map((r) => [String(r.id).toUpperCase(), r.name]))
  }
  // Two versions of one layout read better by version: "version 12" vs "now".
  if (a.layoutId === b.layoutId) {
    if (a.version == null) a.title = 'the layout now'
    if (b.version == null) b.title = 'the layout now'
  }
  const diff = diffSides(a, b, facts)
  const notes = await historyNotes(a, b)
  const complete =
    opts.ai === false
      ? null
      : opts.complete !== undefined
        ? opts.complete
        : await generateComplete()
  let summary: string | null = null
  let points: string[] = []
  let ai_error: string | null = null
  if (complete && diff.sentences.length > 0) {
    try {
      const answer = await complete({
        system: EXPLAIN_DIFF_SYSTEM,
        user: JSON.stringify({
          a: diff.a.title,
          b: diff.b.title,
          differences: diff.sentences.slice(0, 150),
          history_notes: notes.slice(0, 40).map((n) => ({
            form: n.layout_id === a.layoutId ? diff.a.title : diff.b.title,
            version: n.version,
            note: n.note,
            ...(n.times ? { saves: n.times } : {}),
            at: n.at?.slice(0, 10) ?? null,
            by: n.by
          }))
        }),
        maxTokens: 900
      })
      ;({ summary, points } = parseExplainAnswer(answer))
    } catch (err) {
      ai_error = `The AI could not explain it: ${(err as Error).message}`.slice(0, 300)
    }
  }
  return { ...diff, notes, summary, points, ai_configured: !!complete, ai_error }
}
