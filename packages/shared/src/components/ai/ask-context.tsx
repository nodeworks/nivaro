import {
  createContext,
  type DragEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

/**
 * Ask AI from anywhere (#1835 #1933 #1886). The host mounts ONE
 * AskContextProvider above its pages and one AskPanel inside it; a page says
 * what is on screen with usePublishAskContext — the open record, the list or
 * queue with its filters and visible rows, the report with its date range and
 * filters. The panel shows that as a removable chip and sends it with the
 * question as IDS AND FILTERS ONLY: the server reads everything again as the
 * asker, so nothing a page publishes is trusted.
 *
 * Without the provider (a host that never mounts the panel) every hook here
 * is a no-op.
 */

export interface AskRecordRef {
  collection: string
  id: string
  /** What the chip says; never sent. */
  label?: string
}

export interface AskListFilter {
  path: string
  op: string
  value: unknown
  not?: boolean
}

export interface AskPageContext {
  record?: AskRecordRef
  list?: {
    collection: string
    label?: string
    ids: string[]
    filters: AskListFilter[]
    search?: string | null
    total?: number | null
  }
  queue?: {
    id: string
    label?: string
    scope?: string | null
    /** The queue's own filter JSON as the worklist sends it. */
    filters?: string | null
    items: Array<{ collection: string; id: string }>
  }
  report?: {
    id: string
    label?: string
    date_range?: unknown
    entity_filters?: unknown[]
  }
}

/** dataTransfer type for a record dragged into the panel. */
export const ASK_RECORD_MIME = 'application/x-nivaro-record'

/** Window event that opens the panel from outside the provider (command palette). */
export const ASK_OPEN_EVENT = 'nvr:ask-open'

export function openAskPanel(question?: string): void {
  window.dispatchEvent(new CustomEvent(ASK_OPEN_EVENT, { detail: { question: question ?? '' } }))
}

interface AskHost {
  page: AskPageContext | null
  publish: (token: symbol, ctx: AskPageContext | null) => void
  open: boolean
  setOpen: (open: boolean) => void
  /** A question handed in by openAskPanel — the panel fills its box once. */
  seed: { question: string; at: number } | null
}

const AskHostContext = createContext<AskHost | null>(null)

export function useAskHost(): AskHost | null {
  return useContext(AskHostContext)
}

export function AskContextProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Array<{ token: symbol; ctx: AskPageContext }>>([])
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState<AskHost['seed']>(null)

  const publish = useCallback((token: symbol, ctx: AskPageContext | null) => {
    setEntries((prev) => {
      const rest = prev.filter((e) => e.token !== token)
      return ctx ? [...rest, { token, ctx }] : rest
    })
  }, [])

  // ⌘J / Ctrl+J opens (or closes) the panel from any page (#1933).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = (e: Event) => {
      const q = String((e as CustomEvent<{ question?: string }>).detail?.question ?? '')
      setOpen(true)
      if (q) setSeed({ question: q, at: Date.now() })
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(ASK_OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(ASK_OPEN_EVENT, onOpen)
    }
  }, [])

  // The newest publisher wins: a record opened over a list is "this".
  const page = useMemo(
    () => (entries.length ? mergeContexts(entries.map((e) => e.ctx)) : null),
    [entries]
  )
  const value = useMemo<AskHost>(
    () => ({ page, publish, open, setOpen, seed }),
    [page, publish, open, seed]
  )
  return <AskHostContext.Provider value={value}>{children}</AskHostContext.Provider>
}

/** Later publishers override earlier ones key by key. */
export function mergeContexts(list: AskPageContext[]): AskPageContext {
  return Object.assign({}, ...list) as AskPageContext
}

/**
 * Publish what this page shows. Re-publishes only when the context's content
 * changes (compared as JSON), and withdraws it when the page unmounts.
 */
export function usePublishAskContext(ctx: AskPageContext | null | undefined): void {
  const host = useAskHost()
  const token = useRef(Symbol('ask-context')).current
  const key = ctx ? JSON.stringify(ctx) : ''
  const publish = host?.publish
  // `key` stands for ctx's content: the effect re-runs only when it changes.
  useEffect(() => {
    if (!publish) return
    publish(token, key ? (JSON.parse(key) as AskPageContext) : null)
  }, [publish, token, key])
  useEffect(() => {
    if (!publish) return
    return () => publish(token, null)
  }, [publish, token])
}

/**
 * Drag props for a row or chip that can be dropped into the panel (#1886).
 * Only while the panel is open — rows stay text-selectable otherwise.
 */
export function useAskRecordDrag(): (ref: AskRecordRef) => {
  draggable?: boolean
  onDragStart?: (e: DragEvent) => void
} {
  const host = useAskHost()
  const active = !!host?.open
  return useCallback(
    (ref: AskRecordRef) =>
      active
        ? {
            draggable: true,
            onDragStart: (e: DragEvent) => {
              e.dataTransfer.setData(ASK_RECORD_MIME, JSON.stringify(ref))
              e.dataTransfer.setData('text/plain', ref.label || `${ref.collection} ${ref.id}`)
              e.dataTransfer.effectAllowed = 'copy'
            }
          }
        : {},
    [active]
  )
}

/** A dropped record, or null when the drag carried something else. */
export function readDroppedRecord(dt: DataTransfer): AskRecordRef | null {
  const raw = dt.getData(ASK_RECORD_MIME)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const collection = String(v.collection ?? '')
    const id = String(v.id ?? '')
    if (!/^[A-Za-z0-9_]+$/.test(collection) || !id) return null
    return {
      collection,
      id,
      ...(typeof v.label === 'string' && v.label ? { label: v.label.slice(0, 120) } : {})
    }
  } catch {
    return null
  }
}

/** The request body's `context` — ids and filters only, labels stripped. */
export function askContextBody(
  page: AskPageContext | null,
  opts: {
    dismissed: Set<keyof AskPageContext>
    records: AskRecordRef[]
    attachments: string[]
    recordFiles: string[]
  }
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (page?.record && !opts.dismissed.has('record'))
    out.record = { collection: page.record.collection, id: page.record.id }
  if (page?.list && !opts.dismissed.has('list')) {
    const { label: _l, ...list } = page.list
    out.list = list
  }
  if (page?.queue && !opts.dismissed.has('queue')) {
    const { label: _l, ...queue } = page.queue
    out.queue = queue
  }
  if (page?.report && !opts.dismissed.has('report')) {
    const { label: _l, ...report } = page.report
    out.report = report
  }
  if (opts.records.length)
    out.records = opts.records.map((r) => ({ collection: r.collection, id: r.id }))
  if (opts.attachments.length) out.attachments = opts.attachments
  if (out.record && opts.recordFiles.length) out.record_files = opts.recordFiles
  return Object.keys(out).length ? out : undefined
}
