/**
 * "A table a live operations page shows was written" — raised in the process
 * that made the write, at the same driver seam as owner-signal, so no call
 * site (including raw SQL and procedures) has to remember to announce it.
 *
 * It names TOPICS (services/ops-live.ts turns them into a socket poke); it
 * never names the row, the user or a value. Leaf module.
 */

export type OpsWriteTopic =
  | 'issues'
  | 'support'
  | 'team'
  | 'my-work'
  | 'delegation'
  | 'broadcasts'
  | 'integrations'
  | 'access-requests'
  | 'webhooks'
  | 'dead-letters'

const RULES: Array<{ re: RegExp; topics: OpsWriteTopic[]; updateOnly?: boolean }> = [
  { re: /\bnivaro_issues\b/i, topics: ['issues'] },
  { re: /\bnivaro_tasks\b/i, topics: ['my-work', 'support', 'team'] },
  // Ticket replies are comments on a task. `nivaro_comments` is NOT listed here: it carries every
  // record's comments, so it is judged by commentTopics() below (S15).
  { re: /\bnivaro_approval_instances\b/i, topics: ['my-work'] },
  { re: /\bnivaro_sla_(?:acks|escalations|overrides)\b/i, topics: ['team', 'my-work'] },
  { re: /\bnivaro_announcement_(?:acks|deliveries)\b/i, topics: ['broadcasts'] },
  // A broadcast is "opened" when its inbox row is read — an UPDATE.
  { re: /\bnivaro_notifications\b/i, topics: ['broadcasts'], updateOnly: true },
  // The Integrations console (signal rows, partner calls, submissions, obligations).
  {
    re: /\bnivaro_(?:integration_signal_(?:rows|runs|snoozes|settings)|outbound_log|external_api_logs|erp_submissions|integration_obligations)\b/i,
    topics: ['integrations']
  },
  { re: /\bnivaro_access_requests\b/i, topics: ['access-requests'] },
  // Webhook delivery history (a webhook's Deliveries list) and failed flow runs (Dead letters).
  { re: /\bnivaro_webhook_deliveries\b/i, topics: ['webhooks'] },
  { re: /\bnivaro_flow_runs\b/i, topics: ['dead-letters'], updateOnly: true }
]

const WRITE_RE = /^\s*(insert|update|delete|merge)\b/i

/** The collection support tickets live on (nivaro_tasks rows with kind 'support'). */
export const SUPPORT_TICKET_COLLECTION = 'nivaro_tasks'

/**
 * Comment writes poke `support` only for comments on a support ticket. An INSERT names its
 * collection in the column list, so it is read from the bindings (unreadable = poke, fail open).
 * An UPDATE / DELETE names no collection; those routes poke `support` themselves for a ticket
 * comment (routes/comments.ts). Exported for tests.
 */
export function commentTopics(sql: string, verb: string, bindings?: unknown[]): OpsWriteTopic[] {
  if (verb !== 'insert') return []
  const m = /\binsert\s+into\s+nivaro_comments\s*\(([^)]*)\)/i.exec(sql.replace(/[[\]]/g, ''))
  if (!m || !bindings) return ['support']
  const cols = m[1].split(',').map((c) => c.trim().toLowerCase())
  const at = cols.indexOf('collection')
  if (at < 0) return ['support']
  for (let i = at; i < bindings.length; i += cols.length) {
    const v = bindings[i]
    if (typeof v !== 'string' || v === SUPPORT_TICKET_COLLECTION) return ['support']
  }
  return []
}

/** Topics a SQL statement's write touches (empty for reads and unrelated tables). Exported for tests. */
export function opsTopicsOfWrite(sql: string, bindings?: unknown[]): OpsWriteTopic[] {
  if (!sql || sql.length < 12) return []
  const m = WRITE_RE.exec(sql)
  if (!m) return []
  const verb = m[1].toLowerCase()
  const plain = sql.replace(/[[\]]/g, '')
  const out = new Set<OpsWriteTopic>()
  for (const r of RULES) {
    if (r.updateOnly && verb !== 'update') continue
    if (r.re.test(plain)) for (const t of r.topics) out.add(t)
  }
  if (/\bnivaro_comments\b/i.test(plain)) {
    for (const t of commentTopics(sql, verb, bindings)) out.add(t)
  }
  return [...out]
}

type Listener = (topics: OpsWriteTopic[]) => void
const listeners = new Set<Listener>()

export function onOpsWrite(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function raiseOpsWrite(topics: OpsWriteTopic[]): void {
  for (const fn of listeners) {
    try {
      fn(topics)
    } catch {
      /* a live poke that fails must not affect the write */
    }
  }
}
