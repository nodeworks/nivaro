// Investigation group "request" — Task 3 of the Traffic Map drill-down (#1190 #1191 #1202 #1207
// #1213). Registers the inspectables request, trace, statement, compare and capture, the
// "Compare with…" header action on requests, and the "Capture next…" toolbar entry.
// Imported once from registry/index.ts; edit only this folder.
import { shortId } from '../../inspect/format'
import { type InspectRef, inspectables } from '../../registry/inspectables'
import { inspectHeaderActions } from '../../registry/inspectHeaderActions'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import { CaptureNextToolbar, CapturePanel } from './CapturePanel'
import { CompareAction, ComparePanel } from './ComparePanel'
import { comparePair } from './logic'
import { RequestPanel } from './RequestPanel'
import { StatementPanel } from './StatementPanel'
import { TracePanel } from './TracePanel'

register(inspectables, {
  id: 'request',
  label: 'Request',
  Panel: RequestPanel,
  title: (ref: InspectRef) => ref.label ?? `Request ${shortId(ref.id)}`
})

register(inspectables, {
  id: 'trace',
  label: 'Trace',
  Panel: TracePanel,
  title: (ref: InspectRef) => ref.label ?? `Trace ${shortId(ref.id)}`
})

register(inspectables, {
  id: 'statement',
  label: 'Statement',
  Panel: StatementPanel,
  title: (ref: InspectRef) =>
    ref.label
      ? `SQL ${ref.label.length > 40 ? `${ref.label.slice(0, 40)}…` : ref.label}`
      : `SQL ${ref.id.slice(0, 8)}`
})

register(inspectables, {
  id: 'compare',
  label: 'Compare',
  Panel: ComparePanel,
  title: (ref: InspectRef) => {
    const p = comparePair(ref.id)
    return p ? `Compare ${shortId(p[0])} · ${shortId(p[1])}` : 'Compare'
  }
})

register(inspectables, {
  id: 'capture',
  label: 'Capture',
  Panel: CapturePanel,
  title: (ref: InspectRef) => ref.label ?? `Capture ${shortId(ref.id)}`
})

register(inspectHeaderActions, {
  id: 'request-compare-with',
  order: 40,
  applies: (ref) => ref.kind === 'request',
  Component: CompareAction
})

register(toolbarItems, {
  id: 'inspect-capture-next',
  order: 72,
  slot: 'actions',
  Component: CaptureNextToolbar
})
