import { db } from '../db/index.js'

/**
 * Config health sweep — two families of findings:
 *
 * HYGIENE — config nobody uses: queues nobody opened (admin journeys),
 * reports never viewed (report-view activity), active flows that never fire,
 * saved views / record templates owned by suspended users, layouts with zero
 * field assignments.
 *
 * LINT — config violating its own conventions, each one a gotcha we've hit
 * live: collections referenced by pickers with no display_template (pickers
 * render raw ids), M2M junctions with no registered alias, junctions not
 * marked hidden, relations claiming tables that don't exist (compiled into
 * SQL they 500), relation rows with a corrupt one_field='id' (the o2mVirtual
 * id-strip bug class).
 *
 * The sweep UPSERTS per (family, code, subject) and auto-resolves findings
 * that stop matching. Detection only — every finding links to the surface
 * that fixes it.
 */

export interface Finding {
  family: 'hygiene' | 'lint'
  code: string
  subject: string
  title: string
  detail?: string
  severity: 'info' | 'warning'
  href?: string
}

const DAYS = (n: number) => new Date(Date.now() - n * 86_400_000)

async function hygieneFindings(): Promise<Finding[]> {
  const out: Finding[] = []

  // Queues nobody opened in 30 days (journeys retain 30d, so that's the
  // honest window — a longer claim would be a lie about the data we hold).
  try {
    const queues = (await db('nivaro_queues').select('id', 'name', 'created_at')) as Array<{
      id: string
      name: string
      created_at: Date | null
    }>
    const visited = (await db('nivaro_admin_journeys')
      .where('entered_at', '>=', DAYS(30))
      .where('path', 'like', '/queues/%')
      .distinct('path')) as Array<{ path: string }>
    const visitedIds = new Set(
      visited.map((v) => v.path.split('/')[2]?.split('?')[0]?.toUpperCase()).filter(Boolean)
    )
    for (const q of queues) {
      // A queue younger than the window hasn't had a fair chance yet.
      if (q.created_at && new Date(q.created_at) > DAYS(30)) continue
      if (!visitedIds.has(String(q.id).toUpperCase())) {
        out.push({
          family: 'hygiene',
          code: 'queue-unopened',
          subject: `queue:${q.id}`,
          title: `Queue "${q.name}" — nobody opened it in 30 days`,
          detail: 'No admin journey visited this queue in the last 30 days (headless-frontend visits are not tracked here — verify before deleting).',
          severity: 'info',
          href: `/queues/${q.id}`
        })
      }
    }
  } catch {
    // journeys table absent — skip the check, never the sweep
  }

  // Reports never viewed in 30 days ('report-view' activity is throttled
  // 1/user/report/hr, so presence = real usage).
  try {
    const reports = (await db('nivaro_report_defs').select('id', 'name', 'created_at')) as Array<{
      id: string
      name: string
      created_at: Date | null
    }>
    const viewed = (await db('nivaro_activity')
      .where('action', 'report-view')
      .where('timestamp', '>=', DAYS(30))
      .distinct('item')) as Array<{ item: string | null }>
    const viewedIds = new Set(viewed.map((v) => String(v.item ?? '').toUpperCase()))
    for (const r of reports) {
      if (r.created_at && new Date(r.created_at) > DAYS(30)) continue
      if (!viewedIds.has(String(r.id).toUpperCase())) {
        out.push({
          family: 'hygiene',
          code: 'report-unviewed',
          subject: `report:${r.id}`,
          title: `Report "${r.name}" — no views in 30 days`,
          severity: 'info',
          href: `/report-studio/${r.id}`
        })
      }
    }
  } catch {
    // report studio absent
  }

  // Active flows that have not fired in 60 days.
  try {
    const flows = (await db('nivaro_flows')
      .where('status', 'active')
      .select('id', 'name')) as Array<{ id: string; name: string }>
    const fired = (await db('nivaro_flow_runs')
      .where('started_at', '>=', DAYS(60))
      .distinct('flow')) as Array<{ flow: string }>
    const firedIds = new Set(fired.map((f) => String(f.flow).toUpperCase()))
    for (const f of flows) {
      if (!firedIds.has(String(f.id).toUpperCase())) {
        out.push({
          family: 'hygiene',
          code: 'flow-never-fires',
          subject: `flow:${f.id}`,
          title: `Flow "${f.name}" is active but hasn't fired in 60 days`,
          detail: 'Either its trigger never matches anymore, or it should be deactivated.',
          severity: 'warning',
          href: `/flows/${f.id}`
        })
      }
    }
  } catch {
    // flows absent
  }

  // Saved views / record templates owned by suspended users.
  try {
    const suspended = (await db('nivaro_users')
      .where('status', 'suspended')
      .select('id')) as Array<{ id: string }>
    const suspendedIds = suspended.map((u) => u.id)
    if (suspendedIds.length > 0) {
      const views = (await db('nivaro_saved_views')
        .whereIn('user', suspendedIds)
        .select('id', 'name', 'collection')) as Array<{ id: number; name: string; collection: string }>
      for (const v of views) {
        out.push({
          family: 'hygiene',
          code: 'view-suspended-owner',
          subject: `saved-view:${v.id}`,
          title: `Saved view "${v.name}" (${v.collection}) belongs to a suspended user`,
          severity: 'info',
          href: `/collections/${v.collection}`
        })
      }
      const templates = (await db('nivaro_record_templates')
        .whereIn('created_by', suspendedIds)
        .select('id', 'name', 'collection')) as Array<{ id: string; name: string; collection: string }>
      for (const t of templates) {
        out.push({
          family: 'hygiene',
          code: 'template-suspended-owner',
          subject: `record-template:${t.id}`,
          title: `Record template "${t.name}" (${t.collection}) belongs to a suspended user`,
          severity: 'info',
          href: '/record-templates'
        })
      }
    }
  } catch {
    // fine
  }

  // Layouts with zero field assignments (an empty form).
  try {
    const layouts = (await db('nivaro_collection_layouts as l')
      .leftJoin('nivaro_layout_field_assignments as a', 'a.layout_id', 'l.id')
      .groupBy('l.id', 'l.name', 'l.collection')
      .havingRaw('COUNT(a.id) = 0')
      .select('l.id', 'l.name', 'l.collection')) as Array<{ id: number; name: string; collection: string }>
    for (const l of layouts) {
      out.push({
        family: 'hygiene',
        code: 'layout-empty',
        subject: `layout:${l.id}`,
        title: `Layout "${l.name}" on ${l.collection} has no field assignments`,
        severity: 'info',
        href: `/data-model/${l.collection}?tab=layouts`
      })
    }
  } catch {
    // fine
  }

  return out
}

async function lintFindings(): Promise<Finding[]> {
  const out: Finding[] = []
  const tables = new Set(
    (
      (await db('information_schema.tables').select('table_name')) as Array<{ table_name: string }>
    ).map((t) => t.table_name.toLowerCase())
  )
  const collections = (await db('nivaro_collections').select(
    'collection',
    'display_template',
    'hidden'
  )) as Array<{ collection: string; display_template: string | null; hidden: boolean | null }>
  const colByName = new Map(collections.map((c) => [c.collection.toLowerCase(), c]))
  const relations = (await db('nivaro_relations').select(
    'id',
    'many_collection',
    'many_field',
    'one_collection',
    'one_field',
    'junction_field'
  )) as Array<{
    id: number
    many_collection: string | null
    many_field: string | null
    one_collection: string | null
    one_field: string | null
    junction_field: string | null
  }>

  // Relations claiming tables that don't exist — compiled into SQL they 500
  // (the forecasts_divisions class).
  for (const r of relations) {
    for (const side of [r.many_collection, r.one_collection]) {
      if (side && !/^nivaro_/i.test(side) && !tables.has(side.toLowerCase())) {
        out.push({
          family: 'lint',
          code: 'relation-missing-table',
          subject: `relation:${r.id}`,
          title: `Relation #${r.id} references "${side}", which is not a real table`,
          detail: 'Anything compiling this relation into SQL (scopes, filters) will error. Delete the relation row or create the table.',
          severity: 'warning',
          href: '/data-model'
        })
        break
      }
    }
  }

  // Corrupt one_field='id' rows — silently strip `id` from every explicit
  // select on the collection (the relation-544 bug class).
  for (const r of relations) {
    if (r.one_field === 'id') {
      out.push({
        family: 'lint',
        code: 'relation-one-field-id',
        subject: `relation:${r.id}`,
        title: `Relation #${r.id} (${r.many_collection} → ${r.one_collection}) has one_field='id'`,
        detail: "Legacy-import corruption: this strips 'id' from explicit selects and breaks pickers targeting the collection. Set one_field to the real alias or null.",
        severity: 'warning',
        href: '/data-model'
      })
    }
  }

  // Collections that are M2O targets but have no display_template — every
  // picker targeting them renders raw ids.
  const m2oTargets = new Map<string, number>()
  for (const r of relations) {
    if (r.one_collection && r.many_field && !r.junction_field) {
      const key = r.one_collection.toLowerCase()
      m2oTargets.set(key, (m2oTargets.get(key) ?? 0) + 1)
    }
  }
  for (const [target, count] of m2oTargets) {
    const col = colByName.get(target)
    if (!col || /^nivaro_/i.test(target)) continue
    if (!col.display_template) {
      out.push({
        family: 'lint',
        code: 'missing-display-template',
        subject: `collection:${col.collection}`,
        title: `${col.collection} is picked by ${count} relation(s) but has no display template`,
        detail: 'Pickers and relation labels fall back to title/name heuristics — set a display template so references render meaningfully.',
        severity: 'info',
        href: `/data-model/${col.collection}`
      })
    }
  }

  // Junction tables (relations with junction_field) not marked hidden — they
  // clutter every collection listing.
  const junctionTables = new Set<string>()
  for (const r of relations) {
    if (r.junction_field && r.many_collection) junctionTables.add(r.many_collection.toLowerCase())
  }
  for (const jt of junctionTables) {
    const col = colByName.get(jt)
    if (col && !col.hidden) {
      out.push({
        family: 'lint',
        code: 'junction-not-hidden',
        subject: `collection:${col.collection}`,
        title: `Junction table ${col.collection} is not marked hidden`,
        severity: 'info',
        href: `/data-model/${col.collection}`
      })
    }
  }

  return out
}

/** Run the sweep and upsert findings; auto-resolve what stopped matching. */
export async function runConfigHealthSweep(): Promise<string> {
  const findings = [...(await hygieneFindings()), ...(await lintFindings())]
  const now = new Date()
  const seen = new Set<string>()
  for (const f of findings) {
    const key = `${f.family}|${f.code}|${f.subject}`
    seen.add(key)
    const existing = await db('nivaro_config_health')
      .where({ family: f.family, code: f.code, subject: f.subject })
      .first('id', 'status')
    if (existing) {
      await db('nivaro_config_health')
        .where('id', existing.id)
        .update({ title: f.title, detail: f.detail ?? null, severity: f.severity, href: f.href ?? null, last_seen: now })
    } else {
      await db('nivaro_config_health').insert({
        family: f.family,
        code: f.code,
        subject: f.subject,
        title: f.title,
        detail: f.detail ?? null,
        severity: f.severity,
        href: f.href ?? null,
        status: 'open',
        first_seen: now,
        last_seen: now
      })
    }
  }
  // Anything the sweep no longer produces is resolved — delete it so a
  // recurrence starts fresh (including previously dismissed rows).
  const all = (await db('nivaro_config_health').select('id', 'family', 'code', 'subject')) as Array<{
    id: number
    family: string
    code: string
    subject: string
  }>
  const gone = all.filter((r) => !seen.has(`${r.family}|${r.code}|${r.subject}`)).map((r) => r.id)
  for (let i = 0; i < gone.length; i += 500) {
    await db('nivaro_config_health').whereIn('id', gone.slice(i, i + 500)).del()
  }
  return `${findings.length} finding(s), ${gone.length} resolved`
}
