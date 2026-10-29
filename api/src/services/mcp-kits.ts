import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'

/**
 * Role tool kits (#3214): a named set of MCP tools for one kind of job, picked when a person
 * connects an assistant (the OAuth consent page) or later on the connection. A kit is applied
 * through the connection's scope (#3205, services/mcp-scope.ts), so it can only ever take tools
 * away: a buyer kit on an administrator's connection still has no admin tools unless the kit
 * lists them, and an admin tool in a kit does nothing for someone who is not an administrator.
 *
 * Three kits are built in (BUILTIN_KITS) and cannot be changed; administrators add their own in
 * nivaro_mcp_tool_kits (migration 509), which may also name collections and actions.
 */

export type ScopeAction = 'read' | 'create' | 'update' | 'delete'
export const SCOPE_ACTIONS: ScopeAction[] = ['read', 'create', 'update', 'delete']

export interface ToolKit {
  key: string
  label: string
  description: string
  /** Tool names; null = every tool (never for a kit, kept for symmetry with the scope). */
  tools: string[] | null
  collections: string[] | null
  actions: ScopeAction[] | null
  builtin: boolean
  sort: number
}

export const KIT_TABLE = 'nivaro_mcp_tool_kits'
export const KIT_KEY_RE = /^[a-z][a-z0-9_-]{1,47}$/
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/
const COLLECTION_RE = /^[A-Za-z0-9_]{1,64}$/
export const MAX_KITS = 50
const MAX_TOOLS = 300
const MAX_COLLECTIONS = 200

/** Reads every connected assistant starts from: what the data is, and what is waiting. */
const READS = [
  'whoami',
  'list_collections',
  'describe_collection',
  'read_items',
  'read_item',
  'aggregate_items',
  'search',
  'find_people',
  'my_work',
  'list_notifications',
  'list_comments',
  'list_revisions',
  'list_record_files',
  'read_file',
  'list_pipeline_state',
  'list_queues',
  'read_queue',
  'list_tasks',
  'list_approvals',
  'sla_status',
  'list_dashboards',
  'read_dashboard',
  'run_report'
]

const ADMIN_READS = [
  'health',
  'preflight',
  'runtime_stats',
  'db_pool',
  'expensive_sql',
  'traffic_summary',
  'list_cron_jobs',
  'list_job_runs',
  'cpu_profile',
  'explain_access',
  'chaos_what_if',
  'describe_layout',
  'which_form',
  'explain_field',
  'propose_layout_ops',
  // #3209: stored for review, never applied by the assistant
  'propose_schema_change',
  'infra_stacks',
  'infra_containers',
  'infra_updates',
  'infra_swarm',
  'infra_storage',
  'infra_logs',
  'infra_reboot',
  'infra_hosts',
  'infra_proxy',
  'infra_resources',
  'infra_secrets',
  'infra_gitlab',
  'infra_drift'
]

export const BUILTIN_KITS: ToolKit[] = [
  {
    key: 'buyer',
    label: 'Buyer',
    description:
      'Find and read records, raise and update requests, move them along, answer approvals and keep tasks and comments going. No chat, support desk or administration.',
    tools: [
      ...READS,
      'create_item',
      'update_item',
      'transition',
      'decide_approval',
      'add_comment',
      'attach_file',
      'create_task',
      'complete_task',
      'mark_notifications_read'
    ],
    collections: null,
    actions: null,
    builtin: true,
    sort: 10
  },
  {
    key: 'ops',
    label: 'Operations',
    description:
      'Work queues and the support desk: read everything you can, update and move records, claim and answer tickets, run saved queries and the instance’s own tools. Nothing is deleted.',
    tools: [
      ...READS,
      'update_item',
      'transition',
      'add_comment',
      'attach_file',
      'create_task',
      'complete_task',
      'mark_notifications_read',
      'support_tickets',
      'support_ticket',
      'support_claim',
      'support_reply',
      'support_set_status',
      'list_custom_queries',
      'run_custom_query',
      'list_instance_tools',
      'call_instance_tool',
      'ask_data'
    ],
    collections: null,
    actions: null,
    builtin: true,
    sort: 20
  },
  {
    key: 'admin',
    label: 'Administrator (look only)',
    description:
      'Every read plus health, jobs, traffic, access, layout and infrastructure diagnostics. It changes no records; layout and data model ideas are stored as proposals for you to review.',
    tools: [
      ...READS,
      'list_custom_queries',
      'run_custom_query',
      'support_tickets',
      'support_ticket',
      'ask_data',
      ...ADMIN_READS
    ],
    collections: null,
    actions: null,
    builtin: true,
    sort: 30
  }
]

const BUILTIN_KEYS = new Set(BUILTIN_KITS.map((k) => k.key))

function parseList(raw: unknown): unknown[] | null {
  if (raw == null || raw === '') return null
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** Pure: a list of names cleaned (deduped, valid only), or null when "no list". */
export function cleanNames(raw: unknown, re: RegExp, cap: number): string[] | null {
  const list = parseList(raw)
  if (!list) return null
  const out: string[] = []
  for (const v of list) {
    const s = String(v ?? '').trim()
    if (re.test(s) && !out.includes(s)) out.push(s)
    if (out.length >= cap) break
  }
  return out
}

export const cleanTools = (raw: unknown) => cleanNames(raw, TOOL_RE, MAX_TOOLS)
export const cleanCollections = (raw: unknown) => cleanNames(raw, COLLECTION_RE, MAX_COLLECTIONS)
export function cleanActions(raw: unknown): ScopeAction[] | null {
  const list = parseList(raw)
  if (!list) return null
  return SCOPE_ACTIONS.filter((a) => list.includes(a))
}

/** Pure: a posted kit → a clean kit, or why it is refused. */
export function normalizeKit(raw: unknown): { kit: ToolKit } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Send a kit object' }
  const r = raw as Record<string, unknown>
  const key = String(r.key ?? '').trim()
  if (!KIT_KEY_RE.test(key))
    return { error: 'A kit key is 2–48 lower-case letters, digits, _ or -, starting with a letter' }
  if (BUILTIN_KEYS.has(key)) return { error: `"${key}" is a built-in kit — pick another key` }
  const label = String(r.label ?? '').trim()
  if (!label) return { error: 'Give the kit a name' }
  if (r.tools !== undefined && !Array.isArray(r.tools))
    return { error: 'tools must be a list of tool names' }
  const tools = cleanTools(r.tools ?? []) ?? []
  if (!tools.length) return { error: 'A kit needs at least one tool' }
  if (r.collections != null && !Array.isArray(r.collections))
    return { error: 'collections must be a list or null' }
  if (r.actions != null && !Array.isArray(r.actions))
    return { error: 'actions must be a list or null' }
  const actions = r.actions == null ? null : cleanActions(r.actions)
  if (actions && !actions.length) return { error: 'Allow at least one action, or none listed' }
  return {
    kit: {
      key,
      label: label.slice(0, 80),
      description: String(r.description ?? '')
        .trim()
        .slice(0, 500),
      tools,
      collections: r.collections == null ? null : cleanCollections(r.collections),
      actions,
      builtin: false,
      sort: Number.isInteger(r.sort) ? Number(r.sort) : 100
    }
  }
}

export async function kitsReady(): Promise<boolean> {
  return hasColumn(KIT_TABLE, 'key').catch(() => false)
}

interface KitRow {
  key: string
  label: string
  description: string | null
  tools: string | null
  collections: string | null
  actions: string | null
  sort: number | null
}

function rowToKit(r: KitRow): ToolKit {
  return {
    key: r.key,
    label: r.label,
    description: r.description ?? '',
    tools: cleanTools(r.tools) ?? [],
    collections: cleanCollections(r.collections),
    actions: cleanActions(r.actions),
    builtin: false,
    sort: Number(r.sort ?? 100)
  }
}

const cache = new Map<string, { at: number; kits: ToolKit[] }>()
const KIT_TTL_MS = 15_000

/** Every kit: built-in first, then the stored ones by sort + name. 15 s cache per tenant. */
export async function listKits(): Promise<ToolKit[]> {
  const tenant = getTenantId() ?? ''
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < KIT_TTL_MS) return hit.kits
  let stored: ToolKit[] = []
  if (await kitsReady()) {
    const rows = (await db(KIT_TABLE)
      .select('key', 'label', 'description', 'tools', 'collections', 'actions', 'sort')
      .catch(() => [])) as KitRow[]
    stored = rows.map(rowToKit).filter((k) => !BUILTIN_KEYS.has(k.key))
    stored.sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))
  }
  const kits = [...BUILTIN_KITS, ...stored]
  cache.set(tenant, { at: Date.now(), kits })
  return kits
}

export function bustKits(): void {
  cache.clear()
}

export async function kitMap(): Promise<Map<string, ToolKit>> {
  return new Map((await listKits()).map((k) => [k.key, k]))
}

export const isBuiltinKit = (key: string) => BUILTIN_KEYS.has(key)

export async function saveKit(kit: ToolKit, userId: string, isNew: boolean): Promise<void> {
  const now = new Date()
  const row = {
    label: kit.label,
    description: kit.description || null,
    tools: JSON.stringify(kit.tools ?? []),
    collections: kit.collections ? JSON.stringify(kit.collections) : null,
    actions: kit.actions ? JSON.stringify(kit.actions) : null,
    sort: kit.sort,
    updated_by: userId,
    updated_at: now
  }
  if (isNew)
    await db(KIT_TABLE).insert({ key: kit.key, ...row, created_by: userId, created_at: now })
  else await db(KIT_TABLE).where({ key: kit.key }).update(row)
  bustKits()
}

export async function deleteKit(key: string): Promise<boolean> {
  const n = await db(KIT_TABLE).where({ key }).delete()
  bustKits()
  return Number(n) > 0
}

export async function storedKitCount(): Promise<number> {
  const row = (await db(KIT_TABLE).count({ n: '*' }).first()) as { n?: number | string } | undefined
  return Number(row?.n ?? 0)
}
