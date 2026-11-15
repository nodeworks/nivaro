import { db } from '../db/index.js'
import { announceRecordAspect } from './record-events.js'
import {
  canSeeTicket,
  OPEN_STATUSES,
  SUPPORT_KIND,
  type TicketRow,
  type TicketViewer,
  userName
} from './support-tickets.js'

/**
 * "Help requested by Beth" on a record (realtime round 9, item 19).
 *
 * A support request raised from a record (nivaro_tasks kind 'support' with collection + item)
 * shows as a quiet chip in the record's header while it is open. Who sees what follows the
 * support rules (support-tickets.ts `canSeeTicket`):
 *
 *  - only people support lets see the request — the requester, the assignee, the ticket's
 *    team and administrators — see the chip: who asked, its status and a link to it,
 *  - everyone else who can read the record sees nothing (Rob 2026-11-15).
 *
 * Live: every write that opens, picks up, reassigns or closes a request on a record calls
 * `announceRecordHelp`, which sends the `$support` aspect (ids + an aspect name, never the
 * ticket) to the record's viewers; their chip re-reads through GET /support/record/:c/:item.
 */

export interface RecordHelpTicket {
  id: number
  title: string
  status: string
  requested_by: string | null
  requested_by_id: string
  assignee: string | null
  created_at: string | null
}

export interface RecordHelp {
  /** Open requests on the record this person may see (others are not counted). */
  open: number
  /** The open requests this person may see in full, oldest first. */
  tickets: RecordHelpTicket[]
}

type OpenRow = Pick<
  TicketRow,
  'id' | 'title' | 'status' | 'created_by' | 'assignee' | 'team_id' | 'created_at'
> & {
  requester_first?: string | null
  requester_last?: string | null
  requester_email?: string | null
  assignee_first?: string | null
  assignee_last?: string | null
  assignee_email?: string | null
}

/** The chip's answer from the open rows and a visibility judge (pure apart from `canSee`). */
export async function summarizeRecordHelp(
  rows: OpenRow[],
  canSee: (row: OpenRow) => Promise<boolean>
): Promise<RecordHelp> {
  const tickets: RecordHelpTicket[] = []
  for (const r of rows) {
    if (!(await canSee(r))) continue
    tickets.push({
      id: Number(r.id),
      title: String(r.title ?? ''),
      status: String(r.status),
      requested_by: userName({
        first_name: r.requester_first,
        last_name: r.requester_last,
        email: r.requester_email
      }),
      requested_by_id: String(r.created_by),
      assignee: r.assignee
        ? userName({
            first_name: r.assignee_first,
            last_name: r.assignee_last,
            email: r.assignee_email
          })
        : null,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null
    })
  }
  return { open: tickets.length, tickets }
}

/** Open support requests on one record that `viewer` may see. The record gate is the caller's. */
export async function loadRecordHelp(
  viewer: TicketViewer,
  collection: string,
  item: string
): Promise<RecordHelp> {
  const rows = (await db('nivaro_tasks as t')
    .leftJoin('nivaro_users as r', 'r.id', 't.created_by')
    .leftJoin('nivaro_users as a', 'a.id', 't.assignee')
    .where({ 't.kind': SUPPORT_KIND, 't.collection': collection, 't.item': item })
    .whereIn('t.status', OPEN_STATUSES)
    .orderBy('t.created_at', 'asc')
    .limit(20)
    .select(
      't.id',
      't.title',
      't.status',
      't.created_by',
      't.assignee',
      't.team_id',
      't.created_at',
      'r.first_name as requester_first',
      'r.last_name as requester_last',
      'r.email as requester_email',
      'a.first_name as assignee_first',
      'a.last_name as assignee_last',
      'a.email as assignee_email'
    )) as OpenRow[]
  return summarizeRecordHelp(rows, (r) => canSeeTicket(viewer, r as unknown as TicketRow))
}

/** A request on a record opened, moved or closed: tell the record's viewers (best-effort). */
export function announceRecordHelp(
  ticket: { collection?: string | null; item?: string | null } | null | undefined
): void {
  if (!ticket?.collection || ticket.item == null || ticket.item === '') return
  announceRecordAspect(ticket.collection, ticket.item, '$support')
}
