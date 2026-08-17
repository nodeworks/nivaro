import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { readItems } from '../services/items.js'
import type { Policy, Role, User } from '../types.js'

// ─── Static admin page registry ───────────────────────────────────────────────

const ADMIN_PAGES: { label: string; path: string; keywords?: string }[] = [
  { label: 'Overview', path: '/', keywords: 'home dashboard' },
  { label: 'Dashboards', path: '/dashboards', keywords: 'kpi widgets' },
  { label: 'Collections', path: '/collections', keywords: 'content data items' },
  { label: 'Data Model', path: '/data-model', keywords: 'schema fields tables' },
  { label: 'Files', path: '/files', keywords: 'uploads media' },
  { label: 'Hierarchies', path: '/hierarchies', keywords: 'tree levels' },
  { label: 'Record Templates', path: '/record-templates' },
  { label: 'Collection Presets', path: '/collection-presets' },
  { label: 'Users', path: '/users', keywords: 'people accounts' },
  { label: 'Roles', path: '/roles', keywords: 'permissions policies rbac' },
  { label: 'Workspaces', path: '/workspaces' },
  { label: 'Pipelines', path: '/pipelines', keywords: 'owner matrix' },
  { label: 'Flows', path: '/flows', keywords: 'automation inngest' },
  { label: 'Workflows', path: '/workflows', keywords: 'state machine' },
  { label: 'Webhooks', path: '/webhooks' },
  { label: 'Rules', path: '/rules', keywords: 'automation conditions' },
  { label: 'Blackout Dates', path: '/blackout-dates' },
  { label: 'Scheduled Changes', path: '/scheduled-changes' },
  { label: 'Virtual Collections', path: '/virtual-collections' },
  { label: 'External APIs', path: '/external-apis', keywords: 'integrations' },
  { label: 'GraphQL Explorer', path: '/graphql', keywords: 'graphiql' },
  { label: 'Custom Queries', path: '/custom-queries', keywords: 'sql' },
  { label: 'Extensions', path: '/extensions', keywords: 'plugins' },
  { label: 'Analytics', path: '/analytics' },
  { label: 'Presence', path: '/presence' },
  { label: 'Docs', path: '/docs', keywords: 'documentation reference' },
  { label: 'API Docs', path: '/api-docs', keywords: 'rest reference' },
  { label: 'Settings', path: '/settings', keywords: 'configuration ai key' },
  { label: 'Activity', path: '/activity', keywords: 'audit log' },
  { label: 'Reports', path: '/reports', keywords: 'audit' },
  { label: 'Alerts', path: '/alerts', keywords: 'thresholds' },
  { label: 'SLA Rules', path: '/sla-rules' },
  { label: 'Field Watches', path: '/field-watches', keywords: 'changelog' },
  { label: 'Notification Subscriptions', path: '/notification-subscriptions' },
  { label: 'Imports', path: '/imports', keywords: 'csv upload' },
  { label: 'Submission Forms', path: '/submission-forms', keywords: 'public forms' },
  { label: 'Schema Snapshot', path: '/schema-snapshot' },
  { label: 'Profile', path: '/profile', keywords: 'account token' }
]

const QUICK_ACTIONS: { label: string; path: string; keywords?: string }[] = [
  { label: 'New Import', path: '/imports/new', keywords: 'csv upload data' },
  { label: 'New Alert', path: '/alerts/new', keywords: 'threshold' },
  { label: 'Create Workspace', path: '/workspaces', keywords: 'new workspace' },
  { label: 'Open Settings', path: '/settings', keywords: 'configure' }
]

// ─── Field selection ──────────────────────────────────────────────────────────

const PREFERRED_TEXT_FIELDS = ['name', 'title', 'label', 'email', 'subject']

interface FieldRow {
  collection: string
  field: string
  type: string
  hidden: boolean | number
  sort: number | null
}

/** Pick the text-ish fields to search per collection: preferred names first, else first 2 string fields. */
function pickSearchFields(fields: FieldRow[]): string[] {
  const textish = fields.filter((f) => ['string', 'text'].includes(f.type) && !f.hidden)
  const preferred = textish.filter((f) => PREFERRED_TEXT_FIELDS.includes(f.field.toLowerCase()))
  if (preferred.length > 0) return preferred.slice(0, 2).map((f) => f.field)
  return textish
    .sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999))
    .slice(0, 2)
    .map((f) => f.field)
}

// ─── Record search plan ───────────────────────────────────────────────────────
//
// One UNION ALL round trip over each searchable collection's human columns
// (display_template plain tokens, name/title/label/subject, and string-typed
// *_id business identifiers like workflow_id), then the candidate ids are
// CONFIRMED through readItems per collection so RBAC, row-level security and
// User Scopes all apply — the raw scan can never leak a row the items API
// would refuse. Replaces the old first-10-collections per-table search, which
// missed both most collections and every human-id column.

interface PlanEntry {
  collection: string
  display_name: string | null
  columns: string[]
  template: string | null
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const NAMEISH = ['name', 'title', 'label', 'subject']
const MAX_COLS_PER_COLLECTION = 3
const PER_COLLECTION = 5
const RECORD_CAP = 30
// A contains-LIKE is a table scan; multi-million-row tables (invoices 2.7M,
// legacy logs 1.6M) each cost 4-13s and blow the 15s statement timeout for
// the whole union. Tables above this row count are excluded from omnisearch —
// the searchable set stays every collection a person actually types names
// and ids from (workflows, IRs, projects, vendors, units, lines).
const ROW_BUDGET = 500_000

let planCache: { at: number; plan: PlanEntry[] } | null = null

async function buildSearchPlan(): Promise<PlanEntry[]> {
  if (planCache && Date.now() - planCache.at < 60_000) return planCache.plan

  const [collections, stringCols, relations, idTables, rowCounts] = await Promise.all([
    db('nivaro_collections')
      .whereNot('collection', 'like', 'nivaro\\_%')
      .whereNot('collection', 'like', 'directus\\_%')
      .where((qb) => void qb.where('is_virtual', 0).orWhereNull('is_virtual'))
      .select('collection', 'display_name', 'display_template') as Promise<
      Array<{ collection: string; display_name: string | null; display_template: string | null }>
    >,
    db.raw(`
      select table_name, column_name from information_schema.columns
      where data_type in ('nvarchar', 'varchar', 'char', 'nchar')
        and (character_maximum_length between 1 and 2000 or character_maximum_length = -1)
    `) as Promise<Array<{ table_name: string; column_name: string }>>,
    // Junction collections carry no human labels — searching them is noise.
    db('nivaro_relations')
      .whereNotNull('junction_field')
      .select('many_collection') as Promise<Array<{ many_collection: string }>>,
    // Registry junk exists (sysdiagrams made it into nivaro_collections) —
    // every union arm selects `id`, so a table without one breaks the batch.
    db.raw(`select table_name from information_schema.columns where column_name = 'id'`) as Promise<
      Array<{ table_name: string }>
    >,
    // Row counts from partition stats — one query for every table (the
    // config-diff inventory precedent; serial COUNT(*)s took seconds).
    db.raw(`
      select tb.name as table_name, sum(p.rows) as row_count
      from sys.partitions p join sys.tables tb on tb.object_id = p.object_id
      where p.index_id in (0, 1) group by tb.name
    `) as Promise<Array<{ table_name: string; row_count: number | string }>>
  ])

  const junctions = new Set(relations.map((r) => r.many_collection))
  const hasId = new Set(idTables.map((t) => t.table_name))
  const rowsByTable = new Map(rowCounts.map((r) => [r.table_name, Number(r.row_count)]))
  const colsByTable = new Map<string, Set<string>>()
  for (const c of stringCols) {
    const set = colsByTable.get(c.table_name) ?? new Set<string>()
    set.add(c.column_name)
    colsByTable.set(c.table_name, set)
  }

  const plan: PlanEntry[] = []
  for (const col of collections) {
    if (junctions.has(col.collection)) continue
    if (!IDENT_RE.test(col.collection)) continue
    if (!hasId.has(col.collection)) continue
    if ((rowsByTable.get(col.collection) ?? 0) > ROW_BUDGET) continue
    const available = colsByTable.get(col.collection)
    if (!available || !available.size) continue

    const picked: string[] = []
    for (const m of (col.display_template ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
      if (available.has(m[1]) && !picked.includes(m[1])) picked.push(m[1])
    }
    for (const n of NAMEISH) if (available.has(n) && !picked.includes(n)) picked.push(n)
    // String-typed *_id columns are business identifiers (workflow_id,
    // project_id, inventory_request_id) — FK columns are ints/uuids.
    for (const c of available) {
      if (c.endsWith('_id') && c !== 'id' && !picked.includes(c)) picked.push(c)
    }
    const columns = picked.filter((c) => IDENT_RE.test(c)).slice(0, MAX_COLS_PER_COLLECTION)
    if (columns.length === 0) continue
    plan.push({
      collection: col.collection,
      display_name: col.display_name,
      columns,
      template: col.display_template
    })
  }
  planCache = { at: Date.now(), plan }
  return plan
}

function escapeLike(v: string): string {
  return v.replace(/[\\%_[]/g, (m) => `\\${m}`)
}

async function searchRecords(
  user: User,
  readable: string[],
  q: string
): Promise<Array<{ collection: string; id: unknown; label: string; snippet: string }>> {
  const readableSet = new Set(readable)
  const plan = (await buildSearchPlan()).filter((p) => readableSet.has(p.collection))
  if (plan.length === 0) return []

  const like = `%${escapeLike(q)}%`
  const parts: string[] = []
  const bindings: string[] = []
  for (const p of plan) {
    const wheres = p.columns.map((c) => `[${c}] LIKE ? ESCAPE '\\'`).join(' OR ')
    const casts = p.columns.map((c) => `CAST([${c}] AS nvarchar(200))`)
    // T-SQL COALESCE demands ≥2 arguments — a single column goes bare.
    const labelExpr = casts.length > 1 ? `COALESCE(${casts.join(', ')})` : casts[0]
    parts.push(
      `SELECT TOP ${PER_COLLECTION} '${p.collection}' AS c, CAST(id AS nvarchar(64)) AS id, ${labelExpr} AS label FROM [${p.collection}] WHERE ${wheres}`
    )
    bindings.push(...p.columns.map(() => like))
  }

  let candidates: Array<{ c: string; id: string; label: string | null }>
  try {
    candidates = (await db.raw(parts.join(' UNION ALL '), bindings)) as typeof candidates
  } catch {
    planCache = null // stale plan (dropped table/column) — rebuild next request
    return []
  }

  const byCollection = new Map<string, string[]>()
  for (const cand of candidates) {
    const list = byCollection.get(cand.c) ?? []
    if (list.length < PER_COLLECTION) list.push(cand.id)
    byCollection.set(cand.c, list)
  }

  const planByName = new Map(plan.map((p) => [p.collection, p]))
  const results: Array<{ collection: string; id: unknown; label: string; snippet: string }> = []
  await Promise.all(
    [...byCollection.entries()].map(async ([collection, ids]) => {
      try {
        const p = planByName.get(collection)
        const { data: items } = await readItems(user, collection, {
          filter: { id: { _in: ids } },
          limit: ids.length
        })
        for (const item of items as Array<Record<string, unknown>>) {
          const cand = candidates.find(
            (x) => x.c === collection && String(x.id) === String(item.id)
          )
          let label = String(cand?.label ?? item.id ?? '')
          if (p?.template) {
            const rendered = p.template.replace(
              /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g,
              (_m, tok: string) => {
                const v = item[tok.split('.')[0]]
                return v == null || typeof v === 'object' ? '' : String(v)
              }
            )
            if (rendered.trim()) label = rendered.trim()
          }
          results.push({
            collection,
            id: item.id,
            label: label.slice(0, 80),
            snippet: String(cand?.label ?? '').slice(0, 120)
          })
        }
      } catch {
        /* collection unreadable for this user — drop silently */
      }
    })
  )

  const lower = q.toLowerCase()
  results.sort((a, b) => {
    const aExact = a.label.toLowerCase() === lower || String(a.id) === q ? 0 : 1
    const bExact = b.label.toLowerCase() === lower || String(b.id) === q ? 0 : 1
    if (aExact !== bExact) return aExact - bExact
    return a.label.length - b.label.length
  })
  return results.slice(0, RECORD_CAP)
}

function matchStatic(
  list: { label: string; path: string; keywords?: string }[],
  q: string,
  cap: number
) {
  const lower = q.toLowerCase()
  return list
    .filter(
      (p) =>
        p.label.toLowerCase().includes(lower) ||
        (p.keywords ?? '').toLowerCase().includes(lower) ||
        p.path.toLowerCase().includes(lower)
    )
    .slice(0, cap)
    .map(({ label, path }) => ({ label, path }))
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function globalSearchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET /?q= — search records, admin pages, and quick actions
  app.get('/', async (req, reply) => {
    const { q: rawQ } = req.query as { q?: string }
    const q = (rawQ ?? '').trim()

    const pages = q ? matchStatic(ADMIN_PAGES, q, 8) : []
    const actions = q ? matchStatic(QUICK_ACTIONS, q, 4) : []

    if (q.length < 2) {
      return reply.send({ data: { records: [], pages, actions } })
    }

    // Registered, non-system collections
    const collectionRows = await db('nivaro_collections').select('collection')
    const candidates = collectionRows
      .map((c: { collection: string }) => c.collection)
      .filter((c: string) => !c.toLowerCase().startsWith('nivaro_'))

    // Resolve readable collections in one pass (avoid per-collection can() round-trips)
    let readable: string[]
    const user = req.user!
    if (!user.role) {
      readable = []
    } else {
      const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
      if (role?.admin_access) {
        readable = candidates
      } else {
        const policies = await db<Policy>('nivaro_policies').where({
          role: user.role,
          action: 'read'
        })
        const allowed = new Set(policies.map((p) => p.collection))
        readable = allowed.has('*') ? candidates : candidates.filter((c) => allowed.has(c))
      }
    }
    // Field metadata — the semantic block below still labels via pickSearchFields
    const fieldRows = readable.length
      ? ((await db('nivaro_fields')
          .whereIn('collection', readable)
          .select('collection', 'field', 'type', 'hidden', 'sort')) as FieldRow[])
      : []

    const byCollection = new Map<string, FieldRow[]>()
    for (const f of fieldRows) {
      const list = byCollection.get(f.collection) ?? []
      list.push(f)
      byCollection.set(f.collection, list)
    }

    const records = await searchRecords(user as User, readable, q)

    // Semantic hits — meaning-based matches from the embeddings index, deduped
    // against keyword records. Only collections that are both indexed and
    // readable are searched; label resolution goes through a direct id read.
    let semantic: Array<{ collection: string; id: unknown; label: string; snippet: string }> = []
    if (q.length >= 4) {
      try {
        const { embedText, searchEmbeddings } = await import('../services/embeddings.js')
        const indexed = (await db('nivaro_embeddings')
          .distinct('collection')
          .limit(5)) as Array<{ collection: string }>
        const targets = indexed
          .map((r) => r.collection)
          .filter((c) => readable.includes(c))
        if (targets.length > 0) {
          const vec = await embedText(q)
          const seen = new Set(records.map((r) => `${r.collection}:${String(r.id)}`))
          for (const collection of targets) {
            const hits = (await searchEmbeddings(collection, vec, 4)).filter((h) => h.score > 0.15)
            if (hits.length === 0) continue
            const fields = pickSearchFields(byCollection.get(collection) ?? [])
            const labelField = fields[0] ?? 'id'
            const rows = (await db(collection)
              .select(['id', labelField])
              .whereIn('id', hits.map((h) => h.item))) as Array<Record<string, unknown>>
            for (const row of rows) {
              const key = `${collection}:${String(row.id)}`
              if (seen.has(key)) continue
              seen.add(key)
              semantic.push({
                collection,
                id: row.id,
                label: String(row[labelField] ?? row.id).slice(0, 80),
                snippet: 'semantic match'
              })
            }
          }
          semantic = semantic.slice(0, 8)
        }
      } catch {
        semantic = []
      }
    }

    return reply.send({ data: { records, pages, actions, semantic } })
  })
}
