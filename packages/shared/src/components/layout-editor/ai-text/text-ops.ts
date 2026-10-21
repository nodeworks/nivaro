import {
  applyLayoutOps,
  type GroupPatch,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../../../lib/layout-ops'
import { asObject, findPlacement, readOverrides, withKey } from '../inspector/model'
import type { TextProposal } from './types'

/**
 * AI wording proposals → layout ops, built on the draft as it is NOW (the
 * form may have changed since the tools were asked). Each proposal becomes a
 * per-layout override (label, help, placeholder, choices, translation draft)
 * or a group patch (name, intro notice); the batch is checked op by op with
 * the ops twin, so what is returned always applies. Pure.
 */

export interface PlannedText {
  ops: LayoutOp[]
  applied: string[]
  skipped: Array<{ id: string; why: string }>
}

const norm = (v: unknown) => JSON.stringify(v ?? null)

function placementOf(bundle: LayoutBundle, p: TextProposal): PlacementRow | null {
  return p.target.kind === 'placement'
    ? findPlacement(bundle, p.target.field, p.target.group_key)
    : null
}

/** The stored value the proposal would replace, read from the draft. */
export function currentBase(bundle: LayoutBundle, p: TextProposal): unknown {
  if (p.target.kind === 'group') {
    const key = p.target.key
    const g = bundle.groups.find((x) => x.key === key)
    if (!g) return undefined
    return p.key === 'label' ? g.label : (g.content ?? null)
  }
  const row = placementOf(bundle, p)
  if (!row) return undefined
  const ov = readOverrides(row)
  if (p.key === 'choices') return asObject(ov.options).choices ?? null
  if (p.key === 'i18n') return p.i18n ? (asObject(ov.i18n)[p.i18n.locale] ?? null) : null
  return ov[p.key] ?? null
}

/** Why a proposal no longer fits the draft, or null when it does. */
export function staleReason(bundle: LayoutBundle, p: TextProposal): string | null {
  const now = currentBase(bundle, p)
  if (now === undefined)
    return p.target.kind === 'group' ? 'The section is gone' : 'The field is no longer here'
  return norm(now) === norm(p.base) ? null : 'Changed since you asked'
}

function opFor(bundle: LayoutBundle, p: TextProposal): LayoutOp | null {
  if (p.target.kind === 'group') {
    const patch: GroupPatch =
      p.key === 'label' ? { label: p.after } : { content: p.after, content_tone: p.tone ?? 'info' }
    return { op: 'group_update', key: p.target.key, patch }
  }
  const row = placementOf(bundle, p)
  if (!row) return null
  const ov = readOverrides(row)
  let overrides: Record<string, unknown> | null
  if (p.key === 'choices') {
    if (!p.choices) return null
    overrides = withKey(ov, 'options', withKey(asObject(ov.options), 'choices', p.choices.all))
  } else if (p.key === 'i18n') {
    if (!p.i18n) return null
    const { locale, label, help } = p.i18n
    const entry: Record<string, unknown> = { label, draft: true }
    if (help) entry.help = help
    overrides = withKey(ov, 'i18n', { ...asObject(ov.i18n), [locale]: entry })
  } else {
    overrides = withKey(ov, p.key, p.after)
  }
  return {
    op: 'update_placement',
    at: { field: row.field, group_key: row.group_key },
    patch: { overrides }
  }
}

/**
 * The ops for the chosen proposals. `fieldChoices` = proposal ids whose
 * choice labels go to the field instead (a separate call, not layout ops).
 */
export function planTextOps(
  bundle: LayoutBundle,
  proposals: TextProposal[],
  fieldChoices: Set<string> = new Set()
): PlannedText {
  let work = bundle
  const ops: LayoutOp[] = []
  const applied: string[] = []
  const skipped: PlannedText['skipped'] = []
  for (const p of proposals) {
    if (p.key === 'choices' && fieldChoices.has(p.id)) continue
    const stale = staleReason(work, p)
    if (stale) {
      skipped.push({ id: p.id, why: stale })
      continue
    }
    const op = opFor(work, p)
    if (!op) {
      skipped.push({ id: p.id, why: 'Nothing to change' })
      continue
    }
    try {
      work = applyLayoutOps(work, [op])
      ops.push(op)
      applied.push(p.id)
    } catch (e) {
      skipped.push({ id: p.id, why: e instanceof Error ? e.message : String(e) })
    }
  }
  return { ops, applied, skipped }
}

/** The undo label for a batch: "AI wording: 3 changes". */
export function planLabel(tool: string, count: number): string {
  const what: Record<string, string> = {
    glossary: 'glossary wording',
    intros: 'section intros',
    placeholders: 'placeholders',
    choices: 'choice labels',
    reading: 'plainer wording',
    translate: 'translation drafts'
  }
  return `AI ${what[tool] ?? 'wording'}: ${count} change${count === 1 ? '' : 's'}`
}

// ─── #2683 Translation drafts waiting for a person ───────────────────────────

export interface DraftTranslation {
  field: string
  group_key: string | null
  locale: string
  label: string
  help: string | null
}

/** Every translation still marked draft on the form. */
export function draftTranslations(bundle: LayoutBundle): DraftTranslation[] {
  const out: DraftTranslation[] = []
  for (const p of bundle.placements) {
    const i18n = asObject(readOverrides(p).i18n)
    for (const [locale, raw] of Object.entries(i18n)) {
      const e = asObject(raw)
      if (e.draft !== true) continue
      out.push({
        field: p.field,
        group_key: p.group_key,
        locale,
        label: typeof e.label === 'string' ? e.label : '',
        help: typeof e.help === 'string' ? e.help : null
      })
    }
  }
  return out
}

/** Ops that approve drafts: the `draft` flag goes, the text stays. */
export function approveDraftOps(bundle: LayoutBundle, drafts: DraftTranslation[]): LayoutOp[] {
  const byRow = new Map<string, DraftTranslation[]>()
  for (const d of drafts) {
    const k = `${d.group_key ?? ''}\u0000${d.field}`
    byRow.set(k, [...(byRow.get(k) ?? []), d])
  }
  const ops: LayoutOp[] = []
  for (const list of byRow.values()) {
    const row = findPlacement(bundle, list[0].field, list[0].group_key)
    if (!row) continue
    const ov = readOverrides(row)
    const i18n = { ...asObject(ov.i18n) }
    for (const d of list) {
      const { draft: _draft, ...rest } = asObject(i18n[d.locale])
      i18n[d.locale] = rest
    }
    ops.push({
      op: 'update_placement',
      at: { field: row.field, group_key: row.group_key },
      patch: { overrides: withKey(ov, 'i18n', i18n) }
    })
  }
  return ops
}
