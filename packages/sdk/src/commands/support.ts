/**
 * Support desk commands (/api/support) — tickets live on Tasks (kind 'support').
 * Requesters see their own; desk members (a routed team) and administrators the
 * desk. Every gate is the API's, not the SDK's.
 */
import { type Command, cmd } from '../command.js'

export type SupportTicketStatus = 'open' | 'in_progress' | 'done' | 'cancelled'

export interface SupportTicket {
  id: number
  title: string
  description: string | null
  status: SupportTicketStatus
  status_label: string
  priority: string
  collection: string | null
  item: string | null
  record_label: string | null
  category_id: number | null
  category_name: string | null
  team_id: number | null
  team_name: string | null
  assignee: string | null
  assignee_name: string | null
  created_by: string
  requester_name: string | null
  [key: string]: unknown
}

export interface SupportTicketDetail extends SupportTicket {
  thread: Array<{
    id: string
    text: string
    user: string
    user_name: string | null
    created_at: string
    from_requester: boolean
  }>
  history: Array<{ id: number; text: string; user: string; user_name: string | null; at: string }>
  can: { work: boolean; reply: boolean; cancel: boolean; reopen: boolean }
}

/** Tickets the caller may see. scope 'desk' = the desk (403 unless a desk worker). */
export function listSupportTickets(query?: {
  scope?: 'mine' | 'desk'
  status?: string
  category?: number
  assignee?: 'me' | 'unassigned'
  q?: string
  collection?: string
  item?: string
  page?: number
  limit?: number
}): Command<{ data: SupportTicket[]; total: number; page: number; limit: number }> {
  return cmd('GET', '/support/tickets', query as Record<string, unknown> | undefined)
}

/** One ticket with its thread, history and what the caller may do (`can`). */
export function readSupportTicket(id: number): Command<{ data: SupportTicketDetail }> {
  return cmd('GET', `/support/tickets/${id}`)
}

/** Take a ticket: assigned to the caller, In progress. */
export function claimSupportTicket(id: number): Command<{ data: SupportTicket }> {
  return cmd('POST', `/support/tickets/${id}/claim`)
}

/** Reply on a ticket's thread. */
export function replySupportTicket(id: number, text: string): Command<{ data: { ok: boolean } }> {
  return cmd('POST', `/support/tickets/${id}/comments`, undefined, { text })
}

/** Change a ticket's status (requesters: cancel or reopen their own only). */
export function setSupportTicketStatus(
  id: number,
  status: SupportTicketStatus
): Command<{ data: SupportTicket }> {
  return cmd('PATCH', `/support/tickets/${id}`, undefined, { status })
}
