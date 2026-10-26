/**
 * "Who owns what may have changed" — raised in the process that made the
 * write, for caches derived from owner resolution (a person's working-on
 * list, inactive-people scans). They used to wait out their TTL after a
 * transition, a manual owner, a delegate or an owner group changed.
 *
 * Raised at the driver seam, like the configuration epoch, so no call site has
 * to remember. Leaf module.
 */

const TABLES = [
  'nivaro_workflow_instances',
  'nivaro_pipeline_instance_owners',
  'nivaro_pipeline_owner_groups',
  'nivaro_pipeline_owner_group_users',
  'nivaro_pipeline_owner_group_teams',
  'nivaro_user_group_members',
  'nivaro_workflow_bindings'
]
const TABLES_RE = new RegExp(`\\b(?:${TABLES.join('|')})\\b`, 'i')
// nivaro_users is written on almost every request (last_access); only the
// columns that decide whether a person can act count.
const USER_COLUMNS_RE =
  /\b(?:delegate_id|delegate_expires_at|is_out_of_office|is_redacted|status)\b/i

/** Exported for tests. */
export function isOwnerWrite(sql: string): boolean {
  return ownerWriteKind(sql) != null
}

// A transition moves one record (its instance row), and every cache keyed by
// record already hears about that record's own write; any OTHER owner table
// changes who owns records nobody wrote.
const RULE_TABLES_RE = new RegExp(
  `\\b(?:${TABLES.filter((t) => t !== 'nivaro_workflow_instances').join('|')})\\b`,
  'i'
)

/**
 * null: not an owner write. 'records': only workflow instances moved (a
 * transition — the record re-syncs itself). 'rules': owner groups, their
 * people or teams, team members, bindings, manual owners, a delegate or out
 * of office — owners of records nobody wrote changed.
 */
export function ownerWriteKind(sql: string): OwnerChangeKind | null {
  if (!sql) return null
  if (/^\s*(?:select|with)\b/i.test(sql) && !/\b(?:insert|update|delete|merge)\b/i.test(sql)) {
    return null
  }
  const plain = sql.replace(/[[\]]/g, '')
  if (TABLES_RE.test(plain)) {
    return RULE_TABLES_RE.test(plain) ? 'rules' : 'records'
  }
  if (/\b(?:update|merge)\s+nivaro_users\b/i.test(plain)) {
    // Only the SET list matters; a WHERE on status is not a change to it.
    const set = /\bset\b([\s\S]*?)(?:\bwhere\b|\boutput\b|$)/i.exec(plain)?.[1] ?? ''
    return USER_COLUMNS_RE.test(set) ? 'rules' : null
  }
  return /\bdelete\s+(?:from\s+)?nivaro_users\b/i.test(plain) ? 'rules' : null
}

export type OwnerChangeKind = 'records' | 'rules'
type Listener = (change: { kind: OwnerChangeKind }) => void
const listeners = new Set<Listener>()
let raised = 0

export function onOwnersChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function ownersChanged(kind: OwnerChangeKind = 'rules'): void {
  raised++
  for (const fn of listeners) {
    try {
      fn({ kind })
    } catch {
      /* a cache that fails to clear must not affect the write */
    }
  }
}

export function ownerSignalState(): { listeners: number; raised: number } {
  return { listeners: listeners.size, raised }
}
