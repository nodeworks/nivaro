/** Change proposals on locked records (api routes/change-proposals.ts). */

export type ProposalKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'choice'
  | 'relation'

export interface ProposableField {
  field: string
  label: string
  kind: ProposalKind
  relation?: string
  choices?: Array<{ value: unknown; text: string }>
  required?: boolean
  /** what the record holds now, as the proposer reads it */
  current?: unknown
}

export interface ProposalChangeView {
  field: string
  label: string
  kind: ProposalKind | null
  relation?: string
  choices?: Array<{ value: unknown; text: string }>
  from: unknown
  to: unknown
  stale?: boolean
  /** what the field holds now (stale changes only) */
  now?: unknown
}

export interface ProposalView {
  id: number
  status: 'pending' | 'accepting' | 'accepted' | 'declined' | 'withdrawn'
  reason: string
  step: string | null
  created_by: string
  created_by_name: string | null
  created_at: string
  decided_by: string | null
  decided_by_name: string | null
  decided_at: string | null
  decision_note: string | null
  changes: ProposalChangeView[]
  hidden_fields: number
  can_decide: boolean
  decide_reason?: string
  can_withdraw: boolean
}

export interface RecordProposals {
  enabled: boolean
  locked?: boolean
  step?: string | null
  can_propose: boolean
  reason?: string
  fields?: ProposableField[]
  proposals: ProposalView[]
}

export const proposalsQueryKey = (collection: string, item: string) =>
  ['change-proposals', collection, item] as const
