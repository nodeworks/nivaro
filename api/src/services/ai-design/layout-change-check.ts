import type { GroupRow, LayoutBundle, PlacementRow } from '../layout-ops-apply.js'
import {
  type AssistContext,
  factsForPlacement,
  groupLabel,
  idList,
  isFieldPlacement,
  isRequired,
  isShown,
  lockSummary,
  overridesOf,
  parseLoose,
  placementLabel,
  roleNames,
  rolesForPrompt,
  workflowForPrompt
} from './layout-assist-context.js'
import { type AiComplete, asArray, cleanText, parseJsonLoose } from './model.js'

/**
 * AI review of a change before (or as) it is saved (#2684). The editor sends
 * the layout as it was at the last save and as it is now; this module says
 * what changed in plain words (`describeLayoutChange`, deterministic), and
 * the model reads those sentences next to the roles, the workflow and the
 * facts about every touched field, and warns about likely mistakes of
 * intent ("you hid Amount from Finance, who approve this state"). The lint
 * covers the fixed rules; this judges what the admin probably meant.
 *
 * Advice only: a check never blocks or delays a save. A batch that only
 * relabels, reorders inside a section or rewrites help text is trivial and
 * never reaches the model.
 */

const MAX_WARNINGS = 5
const MAX_LINES = 60

export interface ChangeSummary {
  lines: string[]
  /** Anything beyond relabels, help text and reordering inside a section. */
  significant: boolean
  fields: string[]
  groups: string[]
}

const firstPlacements = (b: LayoutBundle) => {
  const out = new Map<string, PlacementRow>()
  for (const p of b.placements) if (isFieldPlacement(p) && !out.has(p.field)) out.set(p.field, p)
  return out
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function diffRoles(before: unknown, after: unknown) {
  const a = new Set(idList(before).map((x) => x.toUpperCase()))
  const b = new Set(idList(after).map((x) => x.toUpperCase()))
  return {
    added: idList(after).filter((x) => !a.has(x.toUpperCase())),
    removed: idList(before).filter((x) => !b.has(x.toUpperCase()))
  }
}

const join = (names: string[]) => (names.length ? names.join(', ') : 'roles that no longer exist')

/** What changed between two versions of one layout, in plain sentences. Pure. */
export function describeLayoutChange(
  before: LayoutBundle,
  after: LayoutBundle,
  ctx: AssistContext
): ChangeSummary {
  const lines: string[] = []
  const fields = new Set<string>()
  const groups = new Set<string>()
  let significant = false
  const say = (line: string, sig: boolean, field?: string, group?: string) => {
    lines.push(line)
    if (sig) significant = true
    if (field) fields.add(field)
    if (group) groups.add(group)
  }

  const pb = firstPlacements(before)
  const pa = firstPlacements(after)
  for (const [field, a] of pa) {
    const b = pb.get(field)
    const label = placementLabel(a, ctx)
    const where = groupLabel(after, a.group_key)
    if (!b) {
      say(`Added "${label}" to "${where}"`, true, field)
      continue
    }
    if (b.group_key !== a.group_key)
      say(`Moved "${label}" from "${groupLabel(before, b.group_key)}" to "${where}"`, true, field)
    if (isShown(b) !== isShown(a))
      say(`${isShown(a) ? 'Showed' : 'Hid'} "${label}" on this form`, true, field)
    if (isRequired(b, ctx) !== isRequired(a, ctx))
      say(
        `Made "${label}" ${isRequired(a, ctx) ? 'required' : 'optional'} on this form`,
        true,
        field
      )
    const ob = overridesOf(b)
    const oa = overridesOf(a)
    if (!same(ob.readonly, oa.readonly))
      say(
        `Made "${label}" ${oa.readonly === true ? 'read-only' : 'editable'} on this form`,
        true,
        field
      )
    if (!same(parseLoose(b.lock_conditions), parseLoose(a.lock_conditions))) {
      const now = lockSummary(a, ctx)
      say(
        `Changed when "${label}" locks: ${now.length ? now.join('; ') : 'never locks now'}`,
        true,
        field
      )
    }
    const lb = placementLabel(b, ctx)
    if (lb !== label) say(`Renamed "${lb}" to "${label}"`, false, field)
    if (!same(ob.note, oa.note)) say(`Changed the help text of "${label}"`, false, field)
    if (!same(ob.interface, oa.interface)) say(`Changed how "${label}" is entered`, true, field)
  }
  for (const [field, b] of pb)
    if (!pa.has(field)) say(`Removed "${placementLabel(b, ctx)}" from the form`, true, field)

  const gb = new Map(before.groups.map((g) => [g.key, g]))
  const ga = new Map(after.groups.map((g) => [g.key, g]))
  const isReal = (g: GroupRow) => !g.key.startsWith('__')
  for (const a of after.groups.filter(isReal)) {
    const b = gb.get(a.key)
    const name = groupLabel(after, a.key)
    if (!b) {
      say(`Added ${a.type === 'tab' ? 'step' : 'section'} "${name}"`, true, undefined, a.key)
      continue
    }
    const hid = diffRoles(b.hidden_for_roles, a.hidden_for_roles)
    if (hid.added.length)
      say(`Hid "${name}" from ${join(roleNames(hid.added, ctx))}`, true, undefined, a.key)
    if (hid.removed.length)
      say(`Showed "${name}" to ${join(roleNames(hid.removed, ctx))} again`, true, undefined, a.key)
    const lock = diffRoles(b.locked_for_roles, a.locked_for_roles)
    if (lock.added.length)
      say(
        `Made "${name}" read-only for ${join(roleNames(lock.added, ctx))}`,
        true,
        undefined,
        a.key
      )
    if (lock.removed.length)
      say(`Let ${join(roleNames(lock.removed, ctx))} edit "${name}" again`, true, undefined, a.key)
    if (!same(parseLoose(b.visible_when), parseLoose(a.visible_when)))
      say(
        a.visible_when
          ? `"${name}" now shows only when ${String(a.visible_when).slice(0, 160)}`
          : `"${name}" now always shows`,
        true,
        undefined,
        a.key
      )
    if (b.is_collapsed !== a.is_collapsed)
      say(`"${name}" now starts ${a.is_collapsed ? 'collapsed' : 'open'}`, true, undefined, a.key)
    if (b.type !== a.type) say(`"${name}" is now a ${a.type}`, true, undefined, a.key)
    if (b.label !== a.label)
      say(`Renamed section "${groupLabel(before, a.key)}" to "${name}"`, false)
  }
  for (const b of before.groups.filter(isReal))
    if (!ga.has(b.key))
      say(`Removed section "${groupLabel(before, b.key)}"`, true, undefined, b.key)

  const roleIdsOf = (l: LayoutBundle) =>
    (parseLoose(l.layout.conditions) as { role_ids?: unknown } | null)?.role_ids
  const who = diffRoles(roleIdsOf(before), roleIdsOf(after))
  if (who.added.length || who.removed.length) {
    const now = roleNames(idList(roleIdsOf(after)), ctx)
    say(`This form now applies to ${now.length ? now.join(', ') : 'every role'}`, true)
  }
  if (
    !same(parseLoose(before.layout.record_conditions), parseLoose(after.layout.record_conditions))
  )
    say('Changed which records get this form', true)
  if (!same(parseLoose(before.layout.default_values), parseLoose(after.layout.default_values)))
    say('Changed the preset values for new records', true)

  // Order only: the same fields in the same section, in another order.
  if (!lines.length) {
    const order = (b: LayoutBundle) =>
      b.placements
        .filter(isFieldPlacement)
        .map((p) => `${p.group_key}:${p.field}`)
        .join(',')
    if (order(before) !== order(after)) say('Reordered fields inside their sections', false)
  }
  return {
    lines: lines.slice(0, MAX_LINES),
    significant,
    fields: [...fields],
    groups: [...groups]
  }
}

export const CHECK_SYSTEM = `You check a change an administrator is about to save (or just saved) to a data-entry form. You get the change in plain sentences, facts about every field it touches (who must fill it, before which workflow move, who may edit it), the roles and the workflow.
Warn ONLY about likely mistakes of intent — for example a field hidden from or made read-only for a role that has to fill it or decide with it at a workflow step, a required field moved somewhere the people who fill it never see, a section hidden from everyone who works in it, a form narrowed to roles that leaves others without one. Do not restate the change, do not praise, do not give style advice.
Answer with ONE JSON object and nothing else:
{"warnings":[{"message":"<one plain sentence, <=200 chars>","field":"<field key or null>","section":"<section key or null>","roles":["<role name>"]}]}
At most 5 warnings; an empty list when nothing looks wrong. Only use field keys, section keys and role names from the input.`

export function buildCheckPrompt(
  after: LayoutBundle,
  ctx: AssistContext,
  summary: ChangeSummary
): string {
  const placed = firstPlacements(after)
  return JSON.stringify({
    collection: ctx.collection,
    changes: summary.lines,
    touched_fields: summary.fields.slice(0, 40).map((f) => {
      const p = placed.get(f)
      return {
        field: f,
        label: p ? placementLabel(p, ctx) : (ctx.fields.get(f)?.label ?? f),
        facts: p ? factsForPlacement(after, p, ctx) : ['no longer on this form']
      }
    }),
    touched_sections: summary.groups
      .slice(0, 20)
      .map((k) => ({ section: k, label: groupLabel(after, k) })),
    roles: rolesForPrompt(ctx),
    workflow: workflowForPrompt(ctx)
  })
}

export interface ChangeWarning {
  message: string
  field: string | null
  field_label: string | null
  section: string | null
  section_label: string | null
  roles: string[]
}

export function parseCheckAnswer(
  text: string,
  after: LayoutBundle,
  before: LayoutBundle,
  ctx: AssistContext
): { warnings: ChangeWarning[]; dropped: number } {
  const parsed = parseJsonLoose(text) ?? {}
  const roleByName = new Map(ctx.roles.map((r) => [r.name.toLowerCase(), r.name]))
  const sectionKeys = new Set([...after.groups, ...before.groups].map((g) => g.key))
  const warnings: ChangeWarning[] = []
  let dropped = 0
  for (const raw of asArray(parsed.warnings)) {
    const o = raw as { message?: unknown; field?: unknown; section?: unknown; roles?: unknown }
    const message = cleanText(o?.message, 220)
    const field = typeof o?.field === 'string' && o.field ? o.field : null
    const section = typeof o?.section === 'string' && o.section ? o.section : null
    const roles = asArray(o?.roles).filter((r): r is string => typeof r === 'string')
    const known = roles.map((r) => roleByName.get(r.toLowerCase()) ?? null)
    // A warning about something that is not on this form or a role that does not exist is a guess.
    if (
      !message ||
      (field && !ctx.fields.has(field)) ||
      (section && !sectionKeys.has(section)) ||
      known.some((r) => r == null)
    ) {
      dropped++
      continue
    }
    const p = field ? after.placements.find((x) => x.field === field) : undefined
    warnings.push({
      message,
      field,
      field_label: field
        ? p
          ? placementLabel(p, ctx)
          : (ctx.fields.get(field)?.label ?? field)
        : null,
      section,
      section_label: section
        ? groupLabel(after.groups.some((g) => g.key === section) ? after : before, section)
        : null,
      roles: known as string[]
    })
    if (warnings.length >= MAX_WARNINGS) break
  }
  return { warnings, dropped }
}

export type CheckResult =
  | { status: 'skipped'; reason: 'empty' | 'trivial'; changes: string[] }
  | { status: 'checked'; changes: string[]; warnings: ChangeWarning[]; dropped: number }

/** The whole check. `complete` null is the caller's 503; a model failure throws. */
export async function checkLayoutChange(
  before: LayoutBundle,
  after: LayoutBundle,
  ctx: AssistContext,
  complete: AiComplete
): Promise<CheckResult> {
  const summary = describeLayoutChange(before, after, ctx)
  if (!summary.lines.length) return { status: 'skipped', reason: 'empty', changes: [] }
  if (!summary.significant) return { status: 'skipped', reason: 'trivial', changes: summary.lines }
  const text = await complete({
    system: CHECK_SYSTEM,
    user: buildCheckPrompt(after, ctx, summary),
    maxTokens: 1200
  })
  const { warnings, dropped } = parseCheckAnswer(text, after, before, ctx)
  return { status: 'checked', changes: summary.lines, warnings, dropped }
}
