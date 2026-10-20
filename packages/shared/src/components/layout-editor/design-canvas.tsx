import type { NivaroClient } from '@nivaro/sdk'
import type { ReactNode, SyntheticEvent } from 'react'
import { NivaroProvider } from '../../context'
import { RealtimeContext } from '../../lib/realtime'
import type { CMSField, SlotAssignment } from '../item-edit/types'
import { type LayoutDesign, LayoutDesignContext } from './design-context'

// The layout editor's canvas is the real record form in design mode
// (spec §7.3). This module holds what design mode needs around it: a client
// that cannot write, a canvas shell that keeps inputs inert, and the
// projection of fetched field metadata onto the editor's draft placements.

/** POSTs that only read (a widget render, a child summary, a preview). */
const READ_ONLY_POSTS =
  /^\/(widgets-internal\/[^/]+\/render|items\/[^/]+\/[^/]+\/child-summary|items\/[^/]+\/auto-id-preview|pipelines\/instance\/[^/]+\/owners\/batch|addendums\/summary|at-risk\/evaluate|items\/batch-read|users\/cards)$/

type AnyCommand = { _method?: string; _path?: string }

export function isDesignAllowedRequest(c: AnyCommand): boolean {
  const method = (c._method ?? 'GET').toUpperCase()
  if (method === 'GET') return true
  return method === 'POST' && READ_ONLY_POSTS.test(c._path ?? '')
}

/** A client whose writes are refused before they leave the browser. */
export function designReadOnlyClient(client: NivaroClient): NivaroClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'request')
        return <T,>(command: unknown): Promise<T> =>
          isDesignAllowedRequest(command as AnyCommand)
            ? target.request<T>(command as never)
            : Promise.reject(new Error('Layout preview: changes are not saved'))
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const insidePass = (t: Element) => !!t.closest('[data-design-pass]')
const editableTarget = (e: SyntheticEvent) => {
  const t = e.target as Element | null
  return !!t?.closest?.(EDITABLE)
}

/**
 * Wraps the form in design mode: the design context for every DesignNode, a
 * read-only client and no realtime (no saves, locks, presence or socket
 * joins), and capture-phase guards that keep the real inputs inert. Clicks on
 * a DesignNode select it (DesignNode handles those); clicks anywhere else are
 * swallowed unless the element is marked data-design-pass (tab switches).
 */
export function DesignCanvas({
  client,
  design,
  children
}: {
  client: NivaroClient
  design: LayoutDesign
  children: ReactNode
}) {
  const block = (e: SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const blockEditing = (e: SyntheticEvent) => {
    if (editableTarget(e)) block(e)
  }
  return (
    <NivaroProvider client={client}>
      <RealtimeContext.Provider value={null}>
        <LayoutDesignContext.Provider value={design}>
          <div
            className='contents'
            data-design-canvas=''
            onClickCapture={(e) => {
              const t = e.target as Element
              if (t.closest('[data-design-target]') || insidePass(t)) return
              block(e)
            }}
            // No focus, no text selection, no Radix trigger opening on
            // pointerdown — the pointer is for selecting and dragging here.
            onPointerDownCapture={(e) => {
              if (!insidePass(e.target as Element)) e.preventDefault()
            }}
            onMouseDownCapture={(e) => {
              if (!insidePass(e.target as Element)) e.preventDefault()
            }}
            onKeyDownCapture={(e) => {
              if (e.key !== 'Tab') blockEditing(e)
            }}
            onBeforeInputCapture={blockEditing}
            onInputCapture={blockEditing}
            onChangeCapture={blockEditing}
            onPasteCapture={blockEditing}
            onCutCapture={blockEditing}
            onDropCapture={blockEditing}
            onSubmitCapture={block}
            onContextMenuCapture={(e) => e.stopPropagation()}
          >
            {children}
          </div>
        </LayoutDesignContext.Provider>
      </RealtimeContext.Provider>
    </NivaroProvider>
  )
}

function parseOverrides(raw: SlotAssignment['overrides']): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * GET /field-config answers for the SAVED layout. The canvas shows the
 * editor's DRAFT, so re-place every field the way the draft does: one row per
 * draft placement (a field placed twice gets two rows), the placement's
 * group/sort/width/label/overrides applied the way the server applies them;
 * fields the draft does not place come back unassigned. Slot keys (`__…`)
 * are not fields and are skipped; a field the server sent no row for cannot
 * render and is skipped too.
 */
export function projectDesignFieldConfig(
  fetched: CMSField[],
  assignments: SlotAssignment[]
): CMSField[] {
  const byField = new Map<string, CMSField[]>()
  for (const f of fetched) {
    const list = byField.get(f.field)
    if (list) list.push(f)
    else byField.set(f.field, [f])
  }
  const placed = new Set<string>()
  const out: CMSField[] = []
  for (const a of assignments) {
    if (!a.field || a.field.startsWith('__')) continue
    const rows = byField.get(a.field)
    if (!rows) continue
    placed.add(a.field)
    const group = a.group_key ?? null
    const base = rows.find((r) => (r.group_key ?? null) === group) ?? rows[0]
    const ov = parseOverrides(a.overrides)
    let options =
      base.options && typeof base.options === 'object'
        ? { ...(base.options as Record<string, unknown>) }
        : base.options
    if (typeof options === 'object' && options) delete options.col_span
    if (a.col_span != null)
      options = {
        ...(typeof options === 'object' && options ? options : {}),
        col_span: a.col_span
      }
    if (ov?.options && typeof ov.options === 'object')
      options = {
        ...(typeof options === 'object' && options ? options : {}),
        ...(ov.options as Record<string, unknown>)
      }
    out.push({
      ...base,
      options,
      label: ov?.label !== undefined ? (ov.label as string | null) : base.label,
      note: ov?.note !== undefined ? (ov.note as string | null) : base.note,
      hidden: ov?.hidden !== undefined ? !!ov.hidden : base.hidden,
      required: ov?.required !== undefined ? !!ov.required : base.required,
      readonly: ov?.readonly !== undefined ? base.readonly || !!ov.readonly : base.readonly,
      placeholder:
        ov?.placeholder !== undefined ? (ov.placeholder as string | null) : base.placeholder,
      group_key: group,
      sort: a.sort,
      layout_assigned: true,
      _overrides: ov
    })
  }
  for (const [name, rows] of byField) {
    if (placed.has(name)) continue
    out.push({ ...rows[0], group_key: null, layout_assigned: false, _overrides: null })
  }
  return out
}
