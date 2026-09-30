/** Shapes served by /api/support (#999). */

export type TicketStatus = 'open' | 'in_progress' | 'done' | 'cancelled'

export interface SupportCategory {
  id: number
  name: string
  description: string | null
  /** The kind of record this type is for; null = offered everywhere. */
  collection: string | null
  team_id: number | null
  team_name: string | null
  default_assignee: string | null
  default_assignee_name: string | null
  is_active: boolean
  sort: number
  legacy: boolean
}

export interface SupportTicket {
  id: number
  title: string
  description: string | null
  status: TicketStatus
  status_label: string
  priority: 'low' | 'normal' | 'urgent'
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
  attachments: string[]
  replies: number
  legacy: boolean
  created_at: string
  updated_at: string | null
  completed_at: string | null
}

export interface SupportTicketDetail extends SupportTicket {
  files: Array<{
    id: string
    title: string | null
    filename_download: string | null
    type: string | null
    filesize: number | string | null
  }>
  thread: Array<{
    id: string
    text: string
    user: string
    user_name: string | null
    created_at: string
    from_requester: boolean
  }>
  history: Array<{
    id: number
    text: string
    user: string | null
    user_name: string | null
    at: string
  }>
  can: { work: boolean; reply: boolean; cancel: boolean; reopen: boolean }
}

export interface SupportSummary {
  mine_open: number
  desk: boolean
  unassigned: number
  assigned_to_me: number
}

export const STATUS_TONE: Record<TicketStatus, string> = {
  open: 'bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300',
  in_progress: 'bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300',
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  cancelled: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'
}
