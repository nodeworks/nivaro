/**
 * "A table a live operations page shows was written" — raised in the process
 * that made the write, at the same driver seam as owner-signal, so no call
 * site (including raw SQL and procedures) has to remember to announce it.
 *
 * It names TOPICS (services/ops-live.ts turns them into a socket poke); it
 * never names the row, the user or a value. Leaf module.
 */

export type OpsWriteTopic = 'issues' | 'support' | 'team' | 'my-work' | 'delegation' | 'broadcasts'

const RULES: Array<{ re: RegExp; topics: OpsWriteTopic[]; updateOnly?: boolean }> = [
  { re: /\bnivaro_issues\b/i, topics: ['issues'] },
  { re: /\bnivaro_tasks\b/i, topics: ['my-work', 'support', 'team'] },
  // Ticket replies and history lines are comments / activity on a task.
  { re: /\bnivaro_comments\b/i, topics: ['support'] },
  { re: /\bnivaro_approval_instances\b/i, topics: ['my-work'] },
  { re: /\bnivaro_sla_(?:acks|escalations|overrides)\b/i, topics: ['team', 'my-work'] },
  { re: /\bnivaro_announcement_(?:acks|deliveries)\b/i, topics: ['broadcasts'] },
  // A broadcast is "opened" when its inbox row is read — an UPDATE.
  { re: /\bnivaro_notifications\b/i, topics: ['broadcasts'], updateOnly: true }
]

const WRITE_RE = /^\s*(insert|update|delete|merge)\b/i

/** Topics a SQL statement's write touches (empty for reads and unrelated tables). Exported for tests. */
export function opsTopicsOfWrite(sql: string): OpsWriteTopic[] {
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
