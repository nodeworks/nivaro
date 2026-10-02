/**
 * Investigation group "record" (Traffic Map drill-down Task 4, #1192 #1193 #1194 #1201):
 *   chain     — an event chain drawn as its path; each step opens what it names
 *   recording — a session replay seeked to the moment (or "follow this person" when none)
 *   record    — a record read-only + the writes near the moment
 *   write     — one activity row and its field delta, chain and request
 *   issue     — one issue log entry (stack, screenshot, replay)
 * Plus: "Watch what they saw" under request levels, and an "Issue" action on server-error rows
 * of the live events list. Imported once from registry/index.ts; edit only this folder.
 */
import { lazy } from 'react'
import { openInspect } from '../../inspect/stack'
import { eventActions } from '../../registry/eventActions'
import { inspectables } from '../../registry/inspectables'
import { inspectFooters } from '../../registry/inspectFooters'
import { register } from '../../registry/registry'
import type { TrafficEventWire } from '../../types'
import { splitRecordRef } from './logic'
import { RequestWatchFooter } from './WatchFooter'

const ChainPanel = lazy(() => import('./ChainPanel'))
const RecordingPanel = lazy(() => import('./RecordingPanel'))
const RecordPanel = lazy(() => import('./RecordPanel'))
const WritePanel = lazy(() => import('./WritePanel'))
const IssuePanel = lazy(() => import('./IssuePanel'))

register(inspectables, {
  id: 'chain',
  label: 'Event path',
  Panel: ChainPanel,
  title: (ref) => ref.label || `Path ${ref.id.slice(0, 8)}`
})
register(inspectables, {
  id: 'recording',
  label: 'Recording',
  Panel: RecordingPanel,
  title: (ref) =>
    ref.label || (ref.id.startsWith('for:') ? 'What they saw' : `Recording ${ref.id.slice(0, 8)}`)
})
register(inspectables, {
  id: 'record',
  label: 'Record',
  Panel: RecordPanel,
  title: (ref) => {
    if (ref.label) return ref.label
    const r = splitRecordRef(ref.id)
    return r ? `${r.collection} ${r.item}` : `Record ${ref.id}`
  }
})
register(inspectables, {
  id: 'write',
  label: 'Write',
  Panel: WritePanel,
  title: (ref) => ref.label || `Write ${ref.id}`
})
register(inspectables, {
  id: 'issue',
  label: 'Issue',
  Panel: IssuePanel,
  title: (ref) =>
    ref.label || (ref.id.startsWith('rid:') ? 'Issue for this request' : `Issue #${ref.id}`)
})

register(inspectFooters, {
  id: 'record-watch-what-they-saw',
  order: 40,
  applies: (ref) => ref.kind === 'request',
  Component: RequestWatchFooter
})

const ROW_LINK =
  'rounded-sm px-1 text-[11px] font-medium text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function OpenIssue({ ev }: { ev: TrafficEventWire }) {
  const rid = ev.rid as string
  return (
    <button
      type='button'
      className={ROW_LINK}
      data-tm-open-issue={rid}
      data-tip='The issue this server error raised in the issue log (matched by its error message and route)'
      onClick={(e) => {
        e.stopPropagation()
        openInspect({ kind: 'issue', id: `rid:${rid}`, at: ev.t }, { root: true })
      }}
    >
      Issue
    </button>
  )
}

register(eventActions, {
  id: 'open-issue',
  order: 25,
  // Only server errors raise issues; the request id is how the issue is found.
  applies: (ev) => ev.kind === 'error' && (ev.status ?? 0) >= 500 && !!ev.rid,
  Component: OpenIssue
})
