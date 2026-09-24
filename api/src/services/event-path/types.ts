/** An event's path: the chain of writes one integration event set off. */

export type StepKind =
  | 'request'
  | 'cron'
  | 'import'
  | 'feed'
  | 'write'
  | 'transition'
  | 'flow'
  | 'push'
  | 'attempt'
  | 'partner_call'
  | 'group'

export interface PathStep {
  key: string // e.g. 'activity:12'
  parent: string | null // parent step key; null = attach to root
  kind: StepKind
  at: string // ISO
  who?: string | null // display name
  record?: { collection: string; item: string; label?: string | null } | null
  summary: string
  failed?: boolean
  inferred?: boolean
  reason?: string | null // why it was matched (inferred) or why it failed
  detail?: StepDetail | null
  api_id?: number | null // for push/partner_call re-parenting
}

export type StepDetail =
  | { type: 'changes'; changes: Array<{ field: string; label: string; old: string; new: string }> }
  | {
      type: 'push'
      status: string
      http_status?: number | null
      attempts?: number
      error?: string | null
      request?: string | null
      response?: string | null
      submission_id: number
    }
  | {
      type: 'call'
      method: string
      url: string
      status?: number | null
      duration_ms?: number | null
      error?: string | null
    }
  | { type: 'flow'; status: string; halted_at?: string | null; error?: string | null }
  | { type: 'transition'; from?: string | null; to?: string | null; comment?: string | null }

export interface PathNode extends PathStep {
  children: PathNode[]
  offset_ms: number
  members?: PathNode[] // for kind 'group'
}

export interface EventPath {
  root: PathNode
  mode: 'exact' | 'inferred'
  truncated: boolean
  step_count: number
  first_failure: string | null
  replay_of: string | null
  replayed_as: string[]
  hidden_steps?: number
  warnings: string[]
}
