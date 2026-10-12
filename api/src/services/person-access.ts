import { db } from '../db/index.js'
import type { User } from '../types.js'
import {
  humanCollection,
  type PersonCollectionFact,
  personCannotSentence,
  personCollectionSentence,
  personName
} from './access-words.js'
import { can } from './permissions.js'
import { compileAccessGates, countVisible } from './record-access.js'
import { approxRows } from './role-change-impact.js'
import { isAdminRole } from './user-scopes.js'

/**
 * #1959 — "Beth sees 4,271 of 88,000 workflows because her Zone filter is
 * Zone 1 and her role reads workflows; she cannot edit invoices."
 *
 * Every visible count comes from the read path's own gates (record-access.ts
 * compileAccessGates → countVisible: role row filter + routed User Scopes,
 * applied as one COUNT), every permission from can(). The "of N" total is
 * the table's approximate size (partition stats — no scan of a 2M-row
 * table just to say "all"). The collections
 * described are the ones that matter to a person: the pipeline-bound ones
 * first, then the role's explicitly granted ones, capped — a role with the
 * "*" read policy would otherwise mean a sentence per table.
 */

export interface PersonAccessSummary {
  user: { id: string; name: string; role: string | null; admin: boolean }
  collections: Array<
    PersonCollectionFact & { collection: string; can_create: boolean; can_delete: boolean }
  >
  cannot_edit: string[]
  /** "Beth has the Vendor role." */
  lead: string
  sentences: string[]
  /** "Beth cannot edit invoices." — null when they can edit all of them. */
  cannot_line: string | null
  summary: string
}

const MAX_COLLECTIONS = 8

/**
 * The collections worth a sentence: pipeline-bound ones first (the work),
 * then the role's explicitly granted ones, biggest first. Hidden
 * collections, M2M junctions and empty tables are left out — "sees all 0 ai
 * prompts" and "sees all 10,990 addendums files" say nothing useful.
 */
async function candidateCollections(roleId: string | null): Promise<string[]> {
  const [boundRows, grantedRows, registeredRows, junctionRows] = await Promise.all([
    db('nivaro_workflow_bindings')
      .distinct('collection')
      .catch(() => []) as Promise<Array<{ collection: string }>>,
    roleId
      ? (db('nivaro_policies')
          .where({ role: roleId })
          .whereIn('action', ['read', 'update'])
          .distinct('collection')
          .catch(() => []) as Promise<Array<{ collection: string }>>)
      : Promise.resolve([] as Array<{ collection: string }>),
    db('nivaro_collections')
      .select('collection', 'hidden')
      .catch(() => []) as Promise<Array<{ collection: string; hidden?: boolean | number }>>,
    db('nivaro_relations')
      .whereNotNull('junction_field')
      .distinct('many_collection')
      .catch(() => []) as Promise<Array<{ many_collection: string }>>
  ])
  const registered = new Set(
    registeredRows.filter((c) => !(c.hidden === true || c.hidden === 1)).map((c) => c.collection)
  )
  const junctions = new Set(junctionRows.map((r) => r.many_collection))
  const usable = (c: string) =>
    !!c && c !== '*' && !/^(nivaro|directus)_/i.test(c) && registered.has(c) && !junctions.has(c)
  const bound = [...new Set(boundRows.map((r) => r.collection).filter(usable))]
  const granted = [
    ...new Set(grantedRows.map((r) => r.collection).filter((c) => usable(c) && !bound.includes(c)))
  ]
  const sizes = await approxRows(granted)
  granted.sort((a, z) => (sizes.get(z) ?? 0) - (sizes.get(a) ?? 0))
  return [...bound, ...granted.filter((c) => (sizes.get(c) ?? 1) > 0)]
}

async function scopeLabels(
  target: string,
  displayField: string,
  values: Array<string | number>
): Promise<string[]> {
  const ids = values.slice(0, 8).map(String)
  if (!ids.length) return []
  try {
    const rows = (await db(target)
      .whereIn('id', ids as never)
      .select('id', db.raw('?? as label', [displayField]))) as Array<{
      id: unknown
      label: unknown
    }>
    const m = new Map(rows.map((r) => [String(r.id), String(r.label ?? r.id)]))
    return ids.map((i) => m.get(i) ?? i)
  } catch {
    return ids
  }
}

/**
 * `selfView`: a non-admin reading their OWN access. Totals are left out —
 * "4,271 of 88,000" would tell them roughly how much is hidden from them.
 */
export async function summarizePersonAccess(
  userId: string,
  opts: { selfView?: boolean } = {}
): Promise<PersonAccessSummary | null> {
  const user = (await db('nivaro_users').where({ id: userId }).first()) as
    | (User & { first_name?: string | null; last_name?: string | null; email?: string | null })
    | undefined
  if (!user) return null
  const name = personName(user)
  const roleRow = user.role
    ? ((await db('nivaro_roles').where({ id: user.role }).first('name')) as
        | { name: string }
        | undefined)
    : undefined
  const admin = await isAdminRole(user.role)
  const head = { id: String(user.id), name, role: roleRow?.name ?? null, admin }
  if (admin) {
    const s = `${name} has an administrator role — they see and can change every record.`
    return {
      user: head,
      collections: [],
      cannot_edit: [],
      lead: s,
      sentences: [],
      cannot_line: null,
      summary: s
    }
  }
  if (!user.role) {
    const s = `${name} has no role, so they cannot see any records.`
    return {
      user: head,
      collections: [],
      cannot_edit: [],
      lead: s,
      sentences: [],
      cannot_line: null,
      summary: s
    }
  }

  const candidates = await candidateCollections(user.role)
  const names = new Map(
    (
      (await db('nivaro_collections')
        .whereIn('collection', candidates.length ? candidates : ['__none__'])
        .select('collection', 'display_name')
        .catch(() => [])) as Array<{ collection: string; display_name: string | null }>
    ).map((c) => [c.collection, c.display_name])
  )

  const readable: string[] = []
  for (const c of candidates) {
    if (readable.length >= MAX_COLLECTIONS) break
    if (await can(user, 'read', c)) readable.push(c)
  }

  const sizes = await approxRows(readable)
  const facts = await Promise.all(
    readable.map(async (c) => {
      const label = humanCollection(c, names.get(c))
      const gates = await compileAccessGates(user, c)
      const narrowed = !!gates.rowFilter || gates.scopes.length > 0 || !!gates.strict
      const total = sizes.get(c) ?? (await countVisible({ ...gates, bypass: true }))
      const visible = narrowed ? await countVisible(gates) : total
      // Stats lag a little; never print "4,300 of 4,271".
      const shownTotal = total != null && visible != null ? Math.max(total, visible) : total
      const [canUpdate, canCreate, canDelete] = await Promise.all([
        can(user, 'update', c),
        can(user, 'create', c),
        can(user, 'delete', c)
      ])
      const scopes = await Promise.all(
        gates.scopes.map(async (g) => ({
          label: g.label,
          values: await scopeLabels(g.target, g.displayField, g.values)
        }))
      )
      return {
        collection: c,
        collection_label: label,
        visible,
        total: opts.selfView ? null : shownTotal,
        can_update: canUpdate,
        can_create: canCreate,
        can_delete: canDelete,
        scopes,
        row_filter: !!gates.rowFilter,
        strict: gates.strict?.label ?? null
      }
    })
  )

  const cannot = facts.filter((f) => !f.can_update).map((f) => f.collection_label)
  const sentences = facts.map((f) => personCollectionSentence(name, f))
  const cannotLine = personCannotSentence(name, cannot)
  const lead =
    facts.length === 0
      ? `${name}'s role (${roleRow?.name ?? 'no name'}) cannot read any of the main collections.`
      : `${name} has the ${roleRow?.name ?? ''} role.`.replace('the  role', 'a role')
  return {
    user: head,
    collections: facts,
    cannot_edit: cannot,
    lead,
    sentences,
    cannot_line: cannotLine,
    summary: [lead, ...sentences.slice(0, 3), ...(cannotLine ? [cannotLine] : [])].join(' ')
  }
}
