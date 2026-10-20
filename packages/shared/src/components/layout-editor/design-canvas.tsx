import type { NivaroClient } from '@nivaro/sdk'
import { type ReactNode, type SyntheticEvent, useMemo, useRef } from 'react'
import { NivaroProvider, useNivaroClient } from '../../context'
import { RealtimeContext } from '../../lib/realtime'
import { type LayoutDesign, LayoutDesignContext } from './design-context'

// The layout editor's canvas is the real record form in design mode
// (spec §7.3). This module holds what design mode needs around it: a client
// that cannot write and a canvas shell that keeps inputs inert.

/** POSTs that only read (a widget render, a child summary, a preview, the
 *  draft layout's field rows). */
const READ_ONLY_POSTS =
  /^\/(field-config\/[^/]+\/project|widgets-internal\/[^/]+\/render|items\/[^/]+\/[^/]+\/child-summary|items\/[^/]+\/auto-id-preview|pipelines\/instance\/[^/]+\/owners\/batch|addendums\/summary|at-risk\/evaluate|items\/batch-read|users\/cards)$/

type AnyCommand = { _method?: string; _path?: string }

export function isDesignAllowedRequest(c: AnyCommand): boolean {
  const method = (c._method ?? 'GET').toUpperCase()
  if (method === 'GET') return true
  return method === 'POST' && READ_ONLY_POSTS.test((c._path ?? '').split('?')[0])
}

/** What a refused call tried: `{method, path}` (GraphQL/upload/import name themselves). */
export type RefusedWrite = { method: string; path: string }

const refused = () => Promise.reject(new Error('Layout preview: changes are not saved'))

/**
 * A client whose writes are refused before they leave the browser. GraphQL,
 * file upload and import parsing are refused whole (a mutation or a stored
 * file is a write). `onRefused` hears every refused attempt.
 */
export function designReadOnlyClient(
  client: NivaroClient,
  onRefused?: (w: RefusedWrite) => void
): NivaroClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'request')
        return <T,>(command: unknown): Promise<T> => {
          const c = command as AnyCommand
          if (isDesignAllowedRequest(c)) return target.request<T>(command as never)
          onRefused?.({ method: (c._method ?? 'GET').toUpperCase(), path: c._path ?? '' })
          return refused()
        }
      if (prop === 'graphql' || prop === 'upload' || prop === 'importParse')
        return () => {
          onRefused?.({ method: String(prop), path: '' })
          return refused()
        }
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
  design,
  onRefusedWrite,
  children
}: {
  design: LayoutDesign
  /** Something inside tried to write (and was refused) — tests, dev tooling. */
  onRefusedWrite?: (w: RefusedWrite) => void
  children: ReactNode
}) {
  const base = useNivaroClient()
  const refusedRef = useRef(onRefusedWrite)
  refusedRef.current = onRefusedWrite
  const client = useMemo(() => designReadOnlyClient(base, (w) => refusedRef.current?.(w)), [base])
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
