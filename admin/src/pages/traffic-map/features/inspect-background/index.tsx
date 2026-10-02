// Investigation group "background" — Task 5 of the Traffic Map drill-down (#1195 #1196 #1197
// #1198): the inspectables ai, job, flow, submission; footers that lead to them from other
// levels; and ticker actions that open the run behind an event.
// Imported once from registry/index.ts; edit only this folder.
import { eventActions } from '../../registry/eventActions'
import { inspectables } from '../../registry/inspectables'
import { inspectFooters } from '../../registry/inspectFooters'
import { register } from '../../registry/registry'
import { AiPanel } from './AiPanel'
import { FlowRunAction, JobRunAction } from './actions'
import { FlowPanel } from './FlowPanel'
import {
  AiCallsFooter,
  BackgroundRunFooter,
  PartnerPushesFooter,
  RUN_CARRYING_KINDS
} from './footers'
import { JobPanel } from './JobPanel'
import { isPartnerDown, runKindOf } from './logic'
import { SubmissionPanel } from './SubmissionPanel'

register(inspectables, {
  id: 'ai',
  label: 'AI call',
  Panel: AiPanel,
  title: (ref) => ref.label ?? `AI call #${ref.id}`
})

register(inspectables, {
  id: 'job',
  label: 'Job run',
  Panel: JobPanel,
  title: (ref) => ref.label ?? `Job run #${ref.id}`
})

register(inspectables, {
  id: 'flow',
  label: 'Flow run',
  Panel: FlowPanel,
  title: (ref) => ref.label ?? `Flow run ${ref.id.slice(0, 8)}`
})

register(inspectables, {
  id: 'submission',
  label: 'Partner push',
  Panel: SubmissionPanel,
  title: (ref) => ref.label ?? `Push #${ref.id}`
})

register(inspectFooters, {
  id: 'background-ai-calls',
  order: 40,
  applies: (ref) => ref.kind === 'request',
  Component: AiCallsFooter
})

register(inspectFooters, {
  id: 'background-run',
  order: 41,
  applies: (ref) => RUN_CARRYING_KINDS.has(ref.kind),
  Component: BackgroundRunFooter
})

// Every partner node, plain `ext:<id>` or extension-declared `x:…` — the server resolves the
// latter to its APIs and says why when it cannot.
register(inspectFooters, {
  id: 'background-partner-pushes',
  order: 42,
  applies: (ref) => ref.kind === 'down' && isPartnerDown(ref.id),
  Component: PartnerPushesFooter
})

register(eventActions, {
  id: 'job-run',
  order: 40,
  applies: (ev) => runKindOf(ev.run) === 'cron',
  Component: JobRunAction
})

register(eventActions, {
  id: 'flow-run',
  order: 41,
  applies: (ev) => runKindOf(ev.run) === 'flow',
  Component: FlowRunAction
})
