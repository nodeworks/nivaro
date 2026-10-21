import type { RoleFieldAccess } from '../layout-field-access.js'
import type { LayoutBundle, LayoutOp } from '../layout-ops-apply.js'
import {
  type AssistContext,
  groupChain,
  groupLabel,
  idList,
  isFieldPlacement,
  isShown,
  placementLabel
} from './layout-assist-context.js'
import { type AiComplete, asArray, cleanText, parseJsonLoose } from './model.js'

/**
 * Sensitive field check (#2689) — ADVICE, not a security control. The model
 * classifies the form's fields from their names and types only (never
 * values) as personal or financial; then the rules work out who sees each
 * one on this form: every role whose field permissions read it (the #2580
 * field-access answer), less the roles a section's hidden_for_roles already
 * keeps out. A field is flagged when a broad audience sees it:
 *
 *   - a single non-admin role holding at least BROAD_SHARE of the active
 *     people (and BROAD_MIN members), or
 *   - non-admin roles that together hold at least half of them.
 *
 * The suggested hidden_for_roles are those broad viewers minus the roles that
 * may edit the field (they enter it) and the roles that run a workflow move
 * needing it. hidden_for_roles is per section, so the change set hides the
 * field's section and says which other fields go with it. The API still
 * returns the field to anyone whose role policy reads it — the real control
 * is the role's field permissions, and the result says so.
 */

export const BROAD_SHARE = 0.2
export const BROAD_MIN = 5
const MAX_FIELDS = 150

export type SensitiveClass = 'personal' | 'financial'

export interface SensitiveChangeSet {
  kind: 'hide_for_roles'
  title: string
  steps: string[]
  ops: LayoutOp[]
  base_rev: string
  group_key: string
  source: 'ai'
}

export interface SensitiveFinding {
  field: string
  label: string
  class: SensitiveClass
  why: string
  seen_by: string[]
  broad: string[]
  suggest: Array<{ id: string; name: string }>
  section: { key: string; label: string } | null
  also_hides: string[]
  message: string
  change_set: SensitiveChangeSet | null
}

export const SENSITIVE_NOTE =
  'Advice, not a security control: hiding a section changes what the form shows, but the API still returns a field to every role whose permissions read it. To really restrict a field, change the role’s field permissions.'

export const SENSITIVE_SYSTEM = `You classify the fields of a data-entry form by the kind of data they hold, from the key, label and type only.
"personal": data about an identifiable private person beyond a plain name — personal email or phone, home address, date of birth, national or tax id, a person's salary or pay rate, health, a person's bank account.
"financial": money and payment data — amounts, prices, costs, budgets, totals, rates, invoice or account numbers, card or bank details.
Plain names or user links on a business record (requester, owner, assignee) are neither.
Answer with ONE JSON object and nothing else:
{"fields":[{"field":"<field key>","class":"personal"|"financial","why":"<=100 chars"}]}
List only personal or financial fields; only keys from the input.`

export function sensitiveInputs(bundle: LayoutBundle, ctx: AssistContext) {
  const seen = new Set<string>()
  const out: Array<{ field: string; label: string; type: string; interface?: string }> = []
  for (const p of bundle.placements) {
    if (!isFieldPlacement(p) || !isShown(p) || seen.has(p.field)) continue
    seen.add(p.field)
    const f = ctx.fields.get(p.field)
    out.push({
      field: p.field,
      label: placementLabel(p, ctx),
      type: f?.type ?? 'string',
      ...(f?.interface ? { interface: f.interface } : {})
    })
    if (out.length >= MAX_FIELDS) break
  }
  return out
}

export function parseSensitiveAnswer(
  text: string,
  known: Set<string>
): { classes: Map<string, { class: SensitiveClass; why: string }>; dropped: number } {
  const parsed = parseJsonLoose(text) ?? {}
  const classes = new Map<string, { class: SensitiveClass; why: string }>()
  let dropped = 0
  for (const raw of asArray(parsed.fields)) {
    const o = raw as { field?: unknown; class?: unknown; why?: unknown }
    const field = typeof o?.field === 'string' ? o.field : ''
    const cls = o?.class === 'personal' || o?.class === 'financial' ? o.class : null
    if (!known.has(field) || !cls) {
      if (cls) dropped++
      continue
    }
    if (classes.has(field)) continue
    classes.set(field, { class: cls, why: cleanText(o.why, 100) ?? `${cls} data` })
  }
  return { classes, dropped }
}

const upper = (s: string) => s.toUpperCase()

/** Who sees each classified field on this form, and what to hide from whom. Pure. */
export function sensitiveFindings(
  bundle: LayoutBundle,
  ctx: AssistContext,
  access: RoleFieldAccess[],
  classes: Map<string, { class: SensitiveClass; why: string }>
): SensitiveFinding[] {
  const members = new Map(ctx.roles.map((r) => [upper(r.id), r.members]))
  const adminIds = new Set(
    [
      ...ctx.roles.filter((r) => r.admin),
      ...access.filter((a) => a.role.admin_access).map((a) => a.role)
    ].map((r) => upper(r.id))
  )
  const population = ctx.roles
    .filter((r) => !adminIds.has(upper(r.id)))
    .reduce((n, r) => n + r.members, 0)
  const broadMin = Math.max(BROAD_MIN, Math.ceil(population * BROAD_SHARE))
  const out: SensitiveFinding[] = []

  for (const [field, c] of classes) {
    const p = bundle.placements.find((x) => x.field === field && isFieldPlacement(x) && isShown(x))
    if (!p) continue
    const chain = groupChain(bundle, p.group_key)
    const hiddenBySection = new Set(chain.flatMap((g) => idList(g.hidden_for_roles).map(upper)))
    const viewers = access.filter(
      (a) =>
        !adminIds.has(upper(a.role.id)) &&
        a.can_read &&
        !a.hidden_fields.includes(field) &&
        !hiddenBySection.has(upper(a.role.id))
    )
    if (!viewers.length) continue
    const seenMembers = viewers.reduce((n, a) => n + (members.get(upper(a.role.id)) ?? 0), 0)
    const broad = viewers.filter((a) => (members.get(upper(a.role.id)) ?? 0) >= broadMin)
    const halfOfAll = population > 0 && seenMembers * 2 >= population
    if (!broad.length && !halfOfAll) continue
    const wide = broad.length ? broad : viewers
    // Roles that enter the field or move the record on with it need to see it.
    const writers = new Set(
      ctx.roles
        .filter(
          (r) => r.can_write && (r.writable_fields == null || r.writable_fields.includes(field))
        )
        .map((r) => upper(r.id))
    )
    const movers = new Set(
      ctx.transitions.filter((t) => t.fields.includes(field)).flatMap((t) => t.role_ids.map(upper))
    )
    const suggest = wide
      .filter((a) => !writers.has(upper(a.role.id)) && !movers.has(upper(a.role.id)))
      .map((a) => ({ id: a.role.id, name: a.role.name }))
    const section = chain.find((g) => g.type === 'section' || g.type === 'tab') ?? null
    const label = placementLabel(p, ctx)
    const also = section
      ? bundle.placements
          .filter(
            (x) =>
              x.group_key === section.key && x.field !== field && isFieldPlacement(x) && isShown(x)
          )
          .map((x) => placementLabel(x, ctx))
      : []
    let change_set: SensitiveChangeSet | null = null
    if (section && suggest.length) {
      const current = idList(section.hidden_for_roles)
      const have = new Set(current.map(upper))
      const next = [...current, ...suggest.map((s) => s.id).filter((id) => !have.has(upper(id)))]
      const name = groupLabel(bundle, section.key)
      change_set = {
        kind: 'hide_for_roles',
        title: `Hide "${name}" from ${suggest.map((s) => s.name).join(', ')}`,
        steps: [
          `Hide section "${name}" from ${suggest.map((s) => s.name).join(', ')}`,
          ...(also.length
            ? [
                `It also hides ${also.slice(0, 6).join(', ')}${also.length > 6 ? ` and ${also.length - 6} more` : ''} from them`
              ]
            : [])
        ],
        ops: [
          {
            op: 'group_update',
            key: section.key,
            patch: { hidden_for_roles: JSON.stringify(next) }
          }
        ],
        base_rev: bundle.rev,
        group_key: section.key,
        source: 'ai'
      }
    }
    const who = wide.map((a) => a.role.name)
    out.push({
      field,
      label,
      class: c.class,
      why: c.why,
      seen_by: viewers.map((a) => a.role.name),
      broad: broad.map((a) => a.role.name),
      suggest,
      section: section ? { key: section.key, label: groupLabel(bundle, section.key) } : null,
      also_hides: also,
      message: `"${label}" looks ${c.class} (${c.why}) and ${who.join(', ')} see${who.length === 1 ? 's' : ''} it on this form${
        halfOfAll
          ? ` — about ${Math.round((seenMembers / population) * 100)}% of active people`
          : ''
      }.`,
      change_set
    })
  }
  return out.sort((a, b) => b.seen_by.length - a.seen_by.length)
}

/** The model only classifies (names and types); who sees what is computed here. */
export async function checkSensitiveFields(
  bundle: LayoutBundle,
  ctx: AssistContext,
  access: RoleFieldAccess[],
  complete: AiComplete
): Promise<{ findings: SensitiveFinding[]; classified: number; dropped: number }> {
  const inputs = sensitiveInputs(bundle, ctx)
  if (!inputs.length) return { findings: [], classified: 0, dropped: 0 }
  const text = await complete({
    system: SENSITIVE_SYSTEM,
    user: JSON.stringify({ collection: ctx.collection, fields: inputs }),
    maxTokens: 2000
  })
  const { classes, dropped } = parseSensitiveAnswer(text, new Set(inputs.map((i) => i.field)))
  return {
    findings: sensitiveFindings(bundle, ctx, access, classes),
    classified: classes.size,
    dropped
  }
}
