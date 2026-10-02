/**
 * Pure helpers for the investigation stack: short ids, breadcrumb titles, ref equality and the
 * most specific ref for a live event. No React, no fetches.
 */
import { type InspectRef, inspectableFor } from '../registry/inspectables'
import type { TrafficEventWire } from '../types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A uuid's first 8 characters; long ids cut at 14 with an ellipsis; short ids as they are. */
export function shortId(id: string): string {
  if (UUID.test(id)) return id.slice(0, 8)
  return id.length > 16 ? `${id.slice(0, 14)}…` : id
}

/** Breadcrumb text of a level: the inspectable's own title, else label, else `<Label> <id>`. */
export function refTitle(ref: InspectRef): string {
  const ins = inspectableFor(ref.kind)
  if (ins?.title) {
    try {
      const t = ins.title(ref)
      if (t) return t
    } catch {
      /* a failing title falls back to the default */
    }
  }
  if (ref.label) return ref.label
  const name = ins?.label ?? ref.kind.charAt(0).toUpperCase() + ref.kind.slice(1)
  return `${name} ${shortId(ref.id)}`
}

/** Two refs name the same level (kind + id; label and time do not matter). */
export function sameRef(a: InspectRef | null | undefined, b: InspectRef | null | undefined) {
  return !!a && !!b && a.kind === b.kind && a.id === b.id
}

const WRITE = new Set(['create', 'update', 'delete'])

/**
 * The most specific level a live event opens: its request when it carries a request id, else the
 * record a write touched, else the entity it hit.
 */
export function refForEvent(ev: TrafficEventWire): InspectRef {
  if (ev.rid) return { kind: 'request', id: ev.rid, at: ev.t, label: ev.route || undefined }
  if (ev.record && WRITE.has(ev.kind))
    return {
      kind: 'record',
      id: `${ev.entity}:${ev.record}`,
      at: ev.t,
      label: `${ev.entity} ${ev.record}`
    }
  return { kind: 'entity', id: `${ev.lane}/${ev.entity}`, at: ev.t }
}

/** "14:02:31" for an epoch ms; "—" when there is none. */
export function fmtClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '—' : d.toTimeString().slice(0, 8)
}
