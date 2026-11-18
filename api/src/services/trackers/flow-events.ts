import type { FastifyBaseLogger } from 'fastify'
import { parseRecordId, type SourceKind } from './sources/types.js'

/**
 * The `gitlab.issue_changed` flow trigger: the inbound appliers call emitIssueChanged after a
 * GitLab change (state, labels, a comment) reached a link. One event per member of the link,
 * ids only (no titles, no comment text) — a flow reads what it needs as its own user. Silent until
 * flow-ops.ts registers the trigger at boot (self-hosted only); the registry is loaded lazily.
 */

export const ISSUE_CHANGED_TRIGGER = 'gitlab.issue_changed'

let logger: FastifyBaseLogger | null = null

/** flow-ops.ts (boot) / tests: start emitting with this logger; null stops it. */
export function setFlowEventLogger(log: FastifyBaseLogger | null): void {
  logger = log
}

export interface IssueChangedEvent {
  connection: number
  link: number
  project_id: number
  iid: number
  change: 'state' | 'labels' | 'comment'
  /** change 'state': the GitLab state now. */
  state?: 'opened' | 'closed'
  /** change 'comment': the GitLab note id. */
  note_id?: number
  members: Array<{ kind: SourceKind; id: string }>
}

/** The thread / record a member lives on (what a flow's Condition can filter on). */
function refOf(kind: SourceKind, id: string): { collection: string; item: string } | null {
  if (kind === 'issue') return { collection: 'nivaro_issues', item: id }
  if (kind === 'ticket') return { collection: 'nivaro_tasks', item: id }
  return parseRecordId(id)
}

/** The flow payloads one change produces (one per member). */
export function issueChangedPayloads(e: IssueChangedEvent): Array<Record<string, unknown>> {
  return e.members.map((m) => {
    const ref = refOf(m.kind, m.id)
    const p: Record<string, unknown> = {
      connection: e.connection,
      link: e.link,
      kind: m.kind,
      source_id: m.id,
      collection: ref?.collection ?? null,
      item: ref?.item ?? null,
      project_id: e.project_id,
      iid: e.iid,
      change: e.change
    }
    if (e.state !== undefined) p.state = e.state
    if (e.note_id !== undefined) p.note_id = e.note_id
    return p
  })
}

/** Fire `gitlab.issue_changed` for every member. Fire-and-forget; never throws. */
export function emitIssueChanged(e: IssueChangedEvent): void {
  const log = logger
  if (!log || !e.members.length) return
  const payloads = issueChangedPayloads(e)
  void import('../../flows/registry.js')
    .then((m) => {
      for (const p of payloads)
        m.emitTrigger(ISSUE_CHANGED_TRIGGER, p, log, undefined, {
          orderKey: `${e.connection}:${e.link}`
        })
    })
    .catch(() => {})
}
