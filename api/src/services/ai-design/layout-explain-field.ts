import { db } from '../../db/index.js'
import { resolveLayout } from '../../routes/collection-layouts.js'
import type { User } from '../../types.js'
import { readOne } from '../items.js'
import { cachedLintContext } from '../layout-analysis.js'
import { roleFieldAccess } from '../layout-field-access.js'
import { mergeInherited } from '../layout-lint.js'
import { HEADER_GROUP_KEY, type PlacementRow, UNGROUPED_KEY } from '../layout-ops-apply.js'
import { parseRecordConditions } from '../layout-patch.js'
import {
  conditionWords,
  fieldLabel,
  groupName,
  jsonList,
  type LayoutFacts,
  loadLayoutFacts,
  overridesOf,
  roleIdsOf,
  roleNamesOf
} from './layout-facts.js'
import { titleCase } from './model.js'

/**
 * "Which form does this record get, and why can't Finance see Zone on it?"
 * (#2694 which_form / explain_field, #2695 ask about this form). Both answer
 * with the SAME code the record page uses: resolveLayout (the /active
 * resolution, as /collection-layouts/explain does) and the role's real field
 * permissions through a synthetic member (preview-as-role). Record values
 * never leave here: a section rule is reported as matched / not matched.
 */

type Obj = Record<string, unknown>

export interface RoleRef {
  id: string
  name: string
  admin: boolean
}

export class LayoutAssistError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

/** A role by id or by name (any case). Null input = none asked; unknown = 404. */
export async function findRole(input: unknown): Promise<RoleRef | null> {
  if (input == null || input === '') return null
  const s = String(input).trim()
  const rows = (await db('nivaro_roles').select('id', 'name', 'admin_access')) as Array<{
    id: string
    name: string
    admin_access: unknown
  }>
  const lower = s.toLowerCase()
  const hit =
    rows.find((r) => String(r.id).toLowerCase() === lower) ??
    rows.find((r) => String(r.name).toLowerCase() === lower) ??
    rows.find((r) => String(r.name).toLowerCase().startsWith(lower))
  if (!hit)
    throw new LayoutAssistError(
      404,
      `No role is called “${s}”. Roles: ${rows
        .map((r) => r.name)
        .slice(0, 30)
        .join(', ')}`
    )
  return { id: String(hit.id), name: String(hit.name), admin: !!hit.admin_access }
}

/** A collection field by key or by its label (any case). */
export function findField(facts: Pick<LayoutFacts, 'ctx' | 'labels'>, input: unknown) {
  const s = String(input ?? '').trim()
  if (!s) throw new LayoutAssistError(400, 'Name a field')
  const lower = s.toLowerCase()
  const fields = facts.ctx.fields.map((f) => f.field)
  const hit =
    fields.find((f) => f.toLowerCase() === lower) ??
    fields.find((f) => fieldLabel(facts, f).toLowerCase() === lower) ??
    fields.find((f) => fieldLabel(facts, f).toLowerCase().includes(lower))
  if (!hit) {
    const near = fields
      .filter((f) => f.toLowerCase().includes(lower.slice(0, 3)))
      .slice(0, 8)
      .map((f) => `${fieldLabel(facts, f)} (${f})`)
    throw new LayoutAssistError(
      404,
      `No field “${s}” on this collection.${near.length ? ` Close: ${near.join(', ')}` : ''}`
    )
  }
  return hit
}

/** Field labels of a collection, for words about rules. */
export async function collectionLabels(
  collection: string
): Promise<Pick<LayoutFacts, 'ctx' | 'labels'>> {
  const ctx = await cachedLintContext(collection)
  return {
    ctx,
    labels: new Map(ctx.fields.map((f) => [f.field, f.label || titleCase(f.field)]))
  }
}

const REASON_WORDS: Record<string, string> = {
  record_rule: 'the record matches its record rule',
  role: 'it is the form for this role',
  default: 'it is the default form',
  fallback: 'no form claimed the record, so the first form answers',
  slug: 'it was opened by its link name',
  type_use: 'it is the form for this kind of use'
}

export interface WhichForm {
  as: string
  record: string | null
  layout: { id: number; name: string } | null
  why: string
  checked: Array<{ layout: string; matched: boolean; why: string }>
}

export async function whichForm(opts: {
  collection: string
  item?: string | null
  role?: RoleRef | null
}): Promise<WhichForm> {
  const role = opts.role ?? null
  const res = await resolveLayout({
    collection: opts.collection,
    item: opts.item ?? null,
    role: role?.id ?? null,
    isAdmin: role ? role.admin : true
  })
  const ids = [...new Set(res.checked.map((c) => c.layout_id))]
  const names = new Map(
    (ids.length
      ? ((await db('nivaro_collection_layouts').whereIn('id', ids).select('id', 'name')) as Array<{
          id: number
          name: string
        }>)
      : []
    ).map((r) => [Number(r.id), String(r.name)])
  )
  const reason = res.reason
  let why = reason ? (REASON_WORDS[reason.kind] ?? reason.kind) : 'no form applies'
  if (reason?.kind === 'record_rule' && reason.rules?.length)
    why = `the record matches its rule (${conditionWords(await collectionLabels(opts.collection), reason.rules)})`
  return {
    as: role ? role.name : 'an administrator',
    record: opts.item ?? null,
    layout: res.row ? { id: Number(res.row.id), name: String(res.row.name ?? '') } : null,
    why,
    checked: res.checked.slice(0, 20).map((c) => ({
      layout: names.get(c.layout_id) ?? `#${c.layout_id}`,
      matched: c.matched,
      why: c.why
    }))
  }
}

/** Simple rule evaluation for a section's "shows when" (eq / neq / in / filled / empty). */
export function ruleMatches(rule: Obj, record: Obj): boolean | null {
  const raw = record[String(rule.field)]
  const op = String(rule.op ?? 'eq').replace(/^_/, '')
  const s = (v: unknown) => String(v ?? '')
  switch (op) {
    case 'eq':
      return s(raw) === s(rule.value)
    case 'neq':
      return s(raw) !== s(rule.value)
    case 'nnull':
      return raw != null && raw !== ''
    case 'null':
      return raw == null || raw === ''
    case 'in':
      return Array.isArray(rule.value) ? rule.value.map(s).includes(s(raw)) : null
    case 'nin':
      return Array.isArray(rule.value) ? !rule.value.map(s).includes(s(raw)) : null
    default:
      return null
  }
}

export interface FieldExplanation {
  field: string
  label: string
  as: string
  record: string | null
  layout: { id: number; name: string } | null
  verdict: 'shown' | 'shown read-only' | 'hidden' | 'not on the form' | 'cannot open the record'
  reasons: string[]
  draft: boolean
}

/**
 * Why a field shows, hides or is read-only for a role (and a record), in the
 * order the record page decides it: can the role open the collection, does
 * its field permission let it read / write the field, which form does it
 * get, is the field on that form, and what the form's own rules do to it.
 */
export async function explainField(opts: {
  collection: string
  field: unknown
  role?: unknown
  item?: string | null
  /** Judge this layout instead of the one the resolver picks. */
  layoutId?: number | null
  /** The editor's draft of `draftLayoutId` (its unsaved changes count). */
  draft?: unknown
  draftLayoutId?: number | null
  /** The admin asking: reads the record (for section rules) with their access. */
  asker: User
}): Promise<FieldExplanation> {
  const role = await findRole(opts.role)
  const item = opts.item ? String(opts.item) : null
  const reasons: string[] = []
  let verdict: FieldExplanation['verdict'] = 'shown'
  let layoutRef: { id: number; name: string } | null = null
  let layoutId = opts.layoutId ?? null
  if (!layoutId) {
    const which = await whichForm({ collection: opts.collection, item, role })
    layoutRef = which.layout
    layoutId = which.layout?.id ?? null
    if (which.layout)
      reasons.push(
        `${which.as} gets the form “${which.layout.name}”${item ? ` for record ${item}` : ''} because ${which.why}.`
      )
  }
  const facts = layoutId
    ? await loadLayoutFacts(layoutId, {
        draft: opts.draftLayoutId === layoutId ? opts.draft : undefined
      })
    : null
  if (facts && String(facts.bundle.layout.collection) !== opts.collection)
    throw new LayoutAssistError(400, 'That layout belongs to another collection')
  if (facts && !layoutRef)
    layoutRef = { id: layoutId as number, name: String(facts.bundle.layout.name ?? '') }
  const ctxFacts = facts ?? (await collectionLabels(opts.collection))
  const field = findField(ctxFacts, opts.field)
  const label = fieldLabel(ctxFacts, field)
  const as = role ? role.name : 'an administrator'

  // 1. Permissions (a role, not an admin).
  if (role && !role.admin) {
    const allFields = ctxFacts.ctx.fields.map((f) => f.field)
    const access = await roleFieldAccess(opts.collection, role, allFields)
    if (!access.can_read) {
      reasons.push(
        `${role.name} may not read ${opts.collection} records at all (role permissions).`
      )
      verdict = 'cannot open the record'
    } else if (access.hidden_fields.includes(field)) {
      reasons.push(
        `${role.name}'s read permission leaves ${label} out, so it never shows for them.`
      )
      verdict = 'hidden'
    } else if (!access.can_update) {
      reasons.push(
        `${role.name} may read but not update these records, so every field is read-only.`
      )
      verdict = 'shown read-only'
    } else if (access.readonly_fields.includes(field)) {
      reasons.push(`${role.name} may read ${label} but their update permission leaves it out.`)
      verdict = 'shown read-only'
    } else reasons.push(`${role.name}'s permissions let them read and update ${label}.`)
  }
  const meta = ctxFacts.ctx.fields.find((f) => f.field === field)
  if (meta?.hidden) reasons.push(`${label} is marked hidden on the field itself (Data Model).`)
  if (meta?.readonly) reasons.push(`${label} is read-only on the field itself (Data Model).`)

  // 2. The form.
  if (!facts) {
    reasons.push('No form applies, so the record page falls back to its plain field list.')
    return { field, label, as, record: item, layout: null, verdict, reasons, draft: false }
  }
  const merged = mergeInherited(facts.bundle, facts.parent)
  const inherited = new Set(merged.inherited?.fields ?? [])
  const placements = (merged.placements as PlacementRow[]).filter((p) => p.field === field)
  const formName = layoutRef?.name ?? String(facts.bundle.layout.name ?? '')
  if (placements.length === 0) {
    reasons.push(`${label} is not placed on the form “${formName}”.`)
    if (verdict === 'shown') verdict = 'not on the form'
    return {
      field,
      label,
      as,
      record: item,
      layout: layoutRef,
      verdict,
      reasons,
      draft: facts.draft
    }
  }
  const groups = [...facts.bundle.groups, ...(facts.parent?.groups ?? [])]
  const roleId = role?.id.toUpperCase() ?? null
  let record: Obj | null | undefined
  const readRecord = async (fields: string[]) => {
    if (record !== undefined || !item) return record ?? null
    record =
      ((await readOne(opts.asker, opts.collection, item, undefined, [
        ...new Set(['id', ...fields])
      ]).catch(() => null)) as Obj | null) ?? null
    if (!record) reasons.push(`Record ${item} was not found, so rules on it were not checked.`)
    return record
  }

  // The record's pipeline state (a state name, not a stored value), for state locks.
  let stateRead: Promise<{ key: string; label: string } | null> | null = null
  const readState = () => {
    if (!item) return Promise.resolve(null)
    stateRead ??= readOne(opts.asker, opts.collection, item, undefined, ['id', '$state'])
      .then((r) => {
        const st = (r as Obj | null)?.$state as { key?: unknown; label?: unknown } | null
        return st?.key ? { key: String(st.key), label: String(st.label ?? st.key) } : null
      })
      .catch(() => null)
    return stateRead
  }

  for (const p of placements) {
    const where =
      p.group_key === HEADER_GROUP_KEY ? 'the header strip' : groupName({ groups }, p.group_key)
    reasons.push(
      `${label} sits in ${where} on “${formName}”${inherited.has(p.field) ? ' (supplied by its parent form)' : ''}.`
    )
    const ov = overridesOf(p)
    if (p.is_visible === false || ov.hidden === true) {
      reasons.push(`The form hides ${label} there for everyone (the field's Look tab).`)
      if (verdict === 'shown' || verdict === 'shown read-only') verdict = 'hidden'
    }
    if (ov.readonly === true) {
      reasons.push(`The form makes ${label} read-only there (the field's Rules tab).`)
      if (verdict === 'shown') verdict = 'shown read-only'
    }
    if (ov.required === true) reasons.push(`The form makes ${label} required there.`)
    for (const c of jsonList(p.lock_conditions) as Obj[]) {
      if (c.type === 'role') {
        const ids = roleIdsOf(c.role_ids)
        if (roleId && ids.includes(roleId)) {
          reasons.push(`The form locks ${label} (read-only) for ${as}.`)
          if (verdict === 'shown') verdict = 'shown read-only'
        } else if (ids.length)
          reasons.push(`The form locks ${label} for ${roleNamesOf(facts, ids).join(', ')}.`)
      } else if (c.type === 'pipeline_state') {
        const raw = jsonList(c.state_keys).map(String)
        const keys = raw.map((k) => titleCase(k))
        if (!keys.length) continue
        reasons.push(
          `The form locks ${label} (read-only) while the record is in ${keys.length === 1 ? 'the state' : 'one of the states'} ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ` and ${keys.length - 6} more` : ''} (the field's Rules tab, Lock).`
        )
        const state = await readState()
        if (state) {
          if (raw.includes(state.key)) {
            reasons.push(
              `Record ${item} is in “${state.label}” now, so ${label} is read-only on it.`
            )
            if (verdict === 'shown') verdict = 'shown read-only'
          } else
            reasons.push(`Record ${item} is in “${state.label}” now, which does not lock ${label}.`)
        } else if (item)
          reasons.push(`Record ${item} has no pipeline state, so this lock does not apply to it.`)
      }
    }

    // The section and every container above it.
    let key: string | null = p.group_key
    for (let depth = 0; key && key !== UNGROUPED_KEY && depth < 6; depth++) {
      const g = groups.find((x) => x.key === key)
      if (!g) break
      const gname = groupName({ groups }, g.key)
      const hiddenFor = roleIdsOf(g.hidden_for_roles)
      const lockedFor = roleIdsOf(g.locked_for_roles)
      if (roleId && hiddenFor.includes(roleId)) {
        reasons.push(`${gname} is hidden for ${as} (the section's Hidden for roles).`)
        if (verdict === 'shown' || verdict === 'shown read-only') verdict = 'hidden'
      } else if (hiddenFor.length && !roleId)
        reasons.push(`${gname} is hidden for ${roleNamesOf(facts, hiddenFor).join(', ')}.`)
      if (roleId && lockedFor.includes(roleId)) {
        reasons.push(`${gname} is read-only for ${as} (the section's Read-only for roles).`)
        if (verdict === 'shown') verdict = 'shown read-only'
      } else if (lockedFor.length && !roleId)
        reasons.push(`${gname} is read-only for ${roleNamesOf(facts, lockedFor).join(', ')}.`)
      const vw = jsonList(g.visible_when) as Obj[]
      if (vw.length) {
        const words = conditionWords(ctxFacts, vw)
        const rec = await readRecord(vw.map((r) => String(r.field)))
        if (rec) {
          const results = vw.map((r) => ruleMatches(r, rec))
          if (results.some((r) => r === false)) {
            reasons.push(
              `${gname} shows only when ${words}; record ${item} does not match, so it is hidden.`
            )
            if (verdict === 'shown' || verdict === 'shown read-only') verdict = 'hidden'
          } else if (results.every((r) => r === true))
            reasons.push(`${gname} shows only when ${words}; record ${item} matches.`)
          else reasons.push(`${gname} shows only when ${words}.`)
        } else reasons.push(`${gname} shows only when ${words}.`)
      }
      key = g.parent_key
    }
  }
  const rules = parseRecordConditions(facts.bundle.layout.record_conditions)
  if (rules?.length)
    reasons.push(`“${formName}” is for records where ${conditionWords(ctxFacts, rules)}.`)
  return { field, label, as, record: item, layout: layoutRef, verdict, reasons, draft: facts.draft }
}
