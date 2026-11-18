/**
 * Support-ticket writes, told to in-process listeners (the GitLab rule engine evaluates ticket
 * rules on them). Every place that raises a ticket or changes its status, priority, type, title
 * or assignee calls `noteTicketWrite` AFTER its own write — the pattern of issue-raise.ts's
 * noteIssueWrite. Fire-and-forget; never throws into, or slows, the writer. No imports: the
 * support routes do not pull in the tracker graph.
 */

export type TicketWriteKind = 'raised' | 'changed'
export interface TicketWriteEvent {
  ticketId: number
  kind: TicketWriteKind
}

type Listener = (e: TicketWriteEvent) => void | Promise<void>
const listeners = new Set<Listener>()

/** Subscribe to ticket writes (in-process only). Returns the unsubscribe function. */
export function onTicketWrite(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Tell listeners a support ticket was just raised or changed. */
export function noteTicketWrite(ticketId: number, kind: TicketWriteKind = 'changed'): void {
  const id = Number(ticketId)
  if (!Number.isSafeInteger(id) || id <= 0 || !listeners.size) return
  for (const fn of [...listeners]) {
    try {
      const r = fn({ ticketId: id, kind })
      if (r && typeof (r as Promise<void>).catch === 'function')
        (r as Promise<void>).catch(() => undefined)
    } catch {
      // a listener never breaks the writer
    }
  }
}

/**
 * A person changed a ticket (status, priority, …): tell listeners, and hand a status / priority
 * change to GitLab sync (close / reopen and label swaps on linked GitLab issues). The tracker graph
 * is loaded lazily; never throws, never slows the writer.
 */
export function ticketChangedByPerson(
  ticketId: number,
  patch: Record<string, unknown>,
  userId: string | null | undefined
): void {
  noteTicketWrite(ticketId, 'changed')
  if (patch.status === undefined && patch.priority === undefined) return
  const at = Date.now()
  void import('./trackers/outbound-sync.js')
    .then((m) =>
      m.afterTicketChange(ticketId, patch, { userId: userId ?? undefined, via: 'user' }, at)
    )
    .catch(() => {})
}
