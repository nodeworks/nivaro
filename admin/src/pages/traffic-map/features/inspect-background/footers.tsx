/**
 * Footers this group adds under other levels: the AI calls a request made, the job / flow run a
 * level's `run` belongs to, and the pushes a partner node received around the moment.
 */
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { useAiCallsForRequest, useRunFor, useSubmissionsFor } from './data'
import { SubmissionList } from './lists'
import {
  flowRunOfDetail,
  fmtCost,
  fmtDuration,
  fmtWhen,
  isoMs,
  isPartnerDown,
  runKindOf,
  runOfDetail,
  timeOfDetail
} from './logic'
import { LIST, Note, Row, Section, StatusPill } from './ui'

/** Levels whose detail may name the background run they belong to. */
export const RUN_CARRYING_KINDS = new Set(['request', 'write', 'trace', 'chain', 'issue'])

/** "AI calls (N)" under a request — rendered only when it made any. */
export function AiCallsFooter({ inspectRef }: InspectPanelProps) {
  const q = useAiCallsForRequest(inspectRef.kind === 'request' ? inspectRef.id : null)
  const calls = q.data?.calls ?? []
  if (!calls.length) return null
  return (
    <Section title={`AI calls (${calls.length})`} hook='footer-ai-calls'>
      <ul className={LIST} data-tm-inspect-ai-calls={calls.length}>
        {calls.map((c) => (
          <Row key={c.id} aside={`${fmtDuration(c.latency_ms)} · ${fmtCost(c.cost_usd)}`}>
            <InspectLink
              inspectRef={{
                kind: 'ai',
                id: c.id,
                at: isoMs(c.created_at),
                label: `AI call #${c.id}${c.feature ? ` · ${c.feature}` : ''}`
              }}
            >
              {`#${c.id} ${c.model ?? ''}`.trim()}
            </InspectLink>
            <span className='ml-1.5'>
              <StatusPill status={c.status} />
            </span>
          </Row>
        ))}
      </ul>
    </Section>
  )
}

/**
 * "Job run" / "Flow run" under any level whose detail names the background run it belongs to
 * (a write a cron tick made…). Reads the level's detail from the shared cache — no extra fetch.
 * The run is picked at the level's own moment: the ref's time, else the anchor, else a time the
 * detail carries. With none of those it says so rather than naming whichever run covers now.
 */
export function BackgroundRunFooter({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const detail = useInspectDetail<unknown>(inspectRef, anchor, windowSec)
  const flowRun = flowRunOfDetail(detail.data)
  const run = flowRun ? null : runOfDetail(detail.data)
  const at = inspectRef.at ?? anchor ?? timeOfDetail(detail.data)
  const q = useRunFor(run, at)
  if (flowRun)
    return (
      <Section title='Flow run' hook='footer-background-run'>
        <InspectLink inspectRef={{ kind: 'flow', id: flowRun }}>
          {`Flow run ${flowRun.slice(0, 8)}`}
        </InspectLink>
      </Section>
    )
  if (!run) return null
  const kind = runKindOf(run)
  const name = run.slice(run.indexOf(':') + 1)
  const title = kind === 'cron' ? 'Job run' : 'Flow run'
  return (
    <Section title={title} hook='footer-background-run'>
      {at == null ? (
        <Note hook='footer-background-run-no-moment'>
          This level carries no time, so the {kind === 'cron' ? `${name} run` : 'flow run'} behind
          it cannot be picked. Open it from the ticker, or set a moment, to find the run.
        </Note>
      ) : q.isLoading ? (
        <Note>Finding the run…</Note>
      ) : q.data ? (
        <div className='grid gap-0.5' data-tm-inspect-footer-run={`${q.data.kind}:${q.data.id}`}>
          <InspectLink
            inspectRef={{
              kind: q.data.kind,
              id: q.data.id,
              at: isoMs(q.data.started_at),
              label: kind === 'cron' ? `${name} run` : undefined
            }}
          >
            {kind === 'cron' ? `${name} · run #${q.data.id}` : `Flow run ${q.data.id.slice(0, 8)}`}
          </InspectLink>
          <Note>
            Started {fmtWhen(q.data.started_at)}
            {q.data.covering ? '' : ' — the closest earlier run; none covers this moment exactly.'}
          </Note>
        </div>
      ) : (
        <Note hook='footer-background-run-none'>
          {kind === 'cron'
            ? `No recorded run of ${name} covers this moment. Quiet jobs keep only their failed ticks, and run history keeps 30 days.`
            : 'No recorded run of this flow covers this moment (runs are deleted with their flow).'}
        </Note>
      )}
    </Section>
  )
}

/**
 * Pushes a partner node received around the investigated moment — a plain `ext:<api id>` node
 * or an extension-declared one (`x:<extension>.<id>`), which the server resolves to its APIs.
 */
export function PartnerPushesFooter({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const node = inspectRef.kind === 'down' && isPartnerDown(inspectRef.id) ? inspectRef.id : null
  const at = inspectRef.at ?? anchor ?? null
  const q = useSubmissionsFor(node, at, windowSec)
  if (node == null) return null
  const rows = q.data?.rows ?? []
  const span = windowSec >= 120 ? `${Math.round(windowSec / 60)} min` : `${windowSec} s`
  return (
    <Section title={`Partner pushes (${rows.length})`} hook='footer-partner-pushes'>
      {q.isLoading ? (
        <Note>Reading the push log…</Note>
      ) : q.isError ? (
        <Note>The push log could not be read.</Note>
      ) : q.data?.reason ? (
        <Note hook='footer-partner-pushes-unresolved'>{q.data.reason}</Note>
      ) : rows.length ? (
        <SubmissionList rows={rows} />
      ) : (
        <Note hook='footer-partner-pushes-none'>
          No stored pushes to this partner within ±{span} of this moment. Calls made outside a push
          (a flow’s raw call, a sync) live in the partner call log, not here.
        </Note>
      )}
    </Section>
  )
}
