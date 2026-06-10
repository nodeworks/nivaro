import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import type { Policy, Role } from '../types.js'

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
    readable = readable.slice(0, 10) // cap collections searched

    // Field metadata for all searched collections in one query
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

    const term = `%${q}%`

    const recordGroups = await Promise.all(
      readable.map(async (collection) => {
        const searchFields = pickSearchFields(byCollection.get(collection) ?? [])
        if (searchFields.length === 0) return []
        try {
          const rows = await db(collection)
            .select(['id', ...searchFields])
            .where((qb) => {
              for (const f of searchFields) {
                qb.orWhere(db.raw('??', [f]), 'like', term)
              }
            })
            .limit(5) // knex emits TOP 5 on MSSQL without offset
          return rows.map((row: Record<string, unknown>) => {
            const labelField = searchFields[0]
            const matched =
              searchFields.find((f) =>
                String(row[f] ?? '')
                  .toLowerCase()
                  .includes(q.toLowerCase())
              ) ?? labelField
            const label = String(row[labelField] ?? row.id ?? '')
            const snippet = String(row[matched] ?? '').slice(0, 120)
            return { collection, id: row.id, label: label.slice(0, 80), snippet }
          })
        } catch {
          // Table might not physically exist or be inaccessible — skip silently
          return []
        }
      })
    )

    const records = recordGroups.flat().slice(0, Math.max(0, 40 - pages.length - actions.length))

    return reply.send({ data: { records, pages, actions } })
  })
}
