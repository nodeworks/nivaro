import type { ComponentType } from 'react'
import type { Registered } from './registry'

/**
 * Investigation stack — the panel kinds a drill-down level can show. A group feature registers
 * one entry per kind with `register(inspectables, { id: '<kind>', … })`; the docked
 * investigation panel (inspect/InspectHost.tsx) renders the current level's `Panel`.
 *
 * Kind ids the groups register (ref id format in brackets):
 *   Task 3 (inspect-request):    request [uuid], trace [uuid], statement [sha1 of the statement
 *                                shape], compare [`rid1,rid2`], capture
 *   Task 4 (inspect-record):     chain [uuid], recording, record [`collection:id`],
 *                                write [activity id, int], issue
 *   Task 5 (inspect-background): ai, job, flow, submission
 *   Task 6 (inspect-entities):   caller [caller key: `k12`, `u<uuid>`, `cron:x`],
 *                                entity [`lane/entity`], query, widget,
 *                                page [page pattern, URI-encoded], down [down node id]
 *   Task 7 (inspect-nav):        load [load id], search
 *   Task 8 (inspect-actions):    notebook
 */
export interface InspectRef {
  kind: string
  id: string
  label?: string
  /** Epoch ms the level is about (the event's second). */
  at?: number
}

export interface InspectPanelProps {
  inspectRef: InspectRef
  /** Push a ref onto the stack (drill one level deeper). */
  open(ref: InspectRef): void
  /** Epoch ms the investigation is anchored at. */
  anchor: number | null
  /** Seconds around the anchor a panel looks at (default 300). */
  windowSec: number
}

export interface Inspectable extends Registered {
  /** Registered.id === kind. Human name: 'Request', 'Trace'… */
  label: string
  Panel: ComponentType<InspectPanelProps>
  /** Breadcrumb text; default `ref.label ?? \`${label} ${shortId}\``. */
  title?(ref: InspectRef): string
}

export const inspectables: Inspectable[] = []

export function inspectableFor(kind: string): Inspectable | null {
  return inspectables.find((x) => x.id === kind) ?? null
}
