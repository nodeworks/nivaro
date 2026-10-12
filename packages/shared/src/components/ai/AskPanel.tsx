import { useQuery } from '@tanstack/react-query'
import {
  ExternalLink,
  FileText,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Paperclip,
  Plus,
  Rows3,
  Send,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { type AiStreamSubscribe, useAiStream } from '../../lib/use-ai-stream'
import { cn } from '../../lib/utils'
import { AiFeedbackButtons } from './AiFeedbackButtons'
import { AiMarkdown } from './AiMarkdown'
import { AiStepList } from './AiStepList'
import {
  type AskPageContext,
  type AskRecordRef,
  askContextBody,
  readDroppedRecord,
  useAskHost
} from './ask-context'

/**
 * The Ask AI panel every page shares (#1835 #1933 #1886 #1842 #1993). It
 * slides over the page, carries the page's context as chips the person can
 * remove, takes records and files dropped on it, offers the open record's
 * attachments as sources, and keeps its questions as one stored conversation
 * ("Open in Ask AI" continues it on the full page).
 *
 * Keys: ⌘J toggles it anywhere; Enter asks; ↑ in an empty box brings back the
 * last question; Esc stops an answer while it streams (and closes the panel
 * when nothing is streaming); ⌘↵ asks the last question again, fresh.
 */

interface Turn {
  role: 'user' | 'assistant'
  content: string
  requestId?: string | null
  stopped?: boolean
}

interface ChatDone {
  reply: string
  request_id?: string | null
  stopped?: boolean
  conversation_id?: string
}

interface DroppedDoc {
  id: string
  name: string
  pages: number | null
  truncated: boolean
}

interface RecordFile {
  id: string
  name: string
  type: string | null
  size: number | null
}

const ACCEPT = '.pdf,.docx,.xlsx,.xls,.xlsm,.csv,.txt,.md,.eml,.html,.htm'
const MAX_RECORDS = 20
const MAX_DOCS = 5

export function AskPanel({
  subscribe,
  connected,
  askPath = '/ask'
}: {
  /** The host's transport for ai:delta / ai:status / ai:done / ai:error. */
  subscribe: AiStreamSubscribe
  connected?: () => boolean
  /** Where the full Ask AI page lives (gets `?conversation=<id>`). */
  askPath?: string
}) {
  const host = useAskHost()
  // Mounted from the first open on and only hidden after, so closing the
  // panel never loses the conversation or an answer still streaming.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    if (host?.open) setMounted(true)
  }, [host?.open])
  if (!host || !mounted || typeof document === 'undefined') return null
  return createPortal(
    <AskPanelBody subscribe={subscribe} connected={connected} askPath={askPath} />,
    document.body
  )
}

function AskPanelBody({
  subscribe,
  connected,
  askPath
}: {
  subscribe: AiStreamSubscribe
  connected?: () => boolean
  askPath: string
}) {
  const host = useAskHost()!
  const client = useNivaroClient()
  const { navigate } = useNavigation()
  const page = host.page
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<keyof AskPageContext>>(new Set())
  const [records, setRecords] = useState<AskRecordRef[]>([])
  const [docs, setDocs] = useState<DroppedDoc[]>([])
  const [uploading, setUploading] = useState(0)
  const [recordFiles, setRecordFiles] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const conversationRef = useRef<string | null>(null)
  conversationRef.current = conversationId

  // A new page = its chips come back, and the record's file choices reset.
  const pageKey = JSON.stringify(page ?? {})
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on page change only
  useEffect(() => {
    setDismissed(new Set())
    setRecordFiles([])
  }, [pageKey])

  // A question handed in by openAskPanel fills the box once.
  const seedAt = host.seed?.at ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once per seed
  useEffect(() => {
    if (host.seed?.question) setInput(host.seed.question)
  }, [seedAt])

  useEffect(() => {
    if (host.open) boxRef.current?.focus()
  }, [host.open])

  const record = page?.record && !dismissed.has('record') ? page.record : null
  const { data: offeredFiles } = useQuery({
    queryKey: ['ask-panel-record-files', record?.collection, record?.id],
    queryFn: () =>
      client
        .request<{ data: RecordFile[] }>(
          get('/ai/ask/record-files', { collection: record!.collection, id: record!.id })
        )
        .then((r) => r.data),
    enabled: !!record,
    staleTime: 60_000,
    retry: false
  })

  const send = useAiStream<ChatDone>(client, {
    subscribe,
    connected,
    onDone: (data) => {
      setTurns((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.reply,
          requestId: data.request_id ?? null,
          stopped: data.stopped === true
        }
      ])
      if (data.conversation_id) setConversationId(data.conversation_id)
    },
    onError: (message) => {
      setError(message || 'Ask AI failed')
      setTurns((prev) => prev.slice(0, -1))
    }
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns.length, send.text, send.steps.length])

  const lastQuestion = [...turns].reverse().find((t) => t.role === 'user')?.content ?? ''

  function ask(text?: string, opts: { fresh?: boolean } = {}) {
    const content = (text ?? input).trim()
    if (!content || send.active) return
    setError(null)
    setTurns((prev) => [...prev, { role: 'user', content }])
    if (text === undefined) setInput('')
    const context = askContextBody(page, {
      dismissed,
      records,
      attachments: docs.map((d) => d.id),
      recordFiles
    })
    const target = conversationRef.current
    // No stored conversation (history turned off, or the first question): the
    // earlier turns ride along so a follow-up still has its thread.
    const earlier = target
      ? []
      : turns.slice(-18).map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }))
    void send.start({
      messages: [...earlier, { role: 'user', content }],
      ...(target ? { conversation_id: target } : { save: true }),
      ...(opts.fresh ? { fresh: true } : {}),
      ...(context ? { context } : {})
    })
  }

  async function upload(files: File[]) {
    const room = MAX_DOCS - docs.length
    for (const file of files.slice(0, Math.max(0, room))) {
      setUploading((n) => n + 1)
      try {
        const form = new FormData()
        form.append('file', file, file.name)
        const token = client.getToken()
        const res = await fetch(`${client.url}/api/ai/ask/attachments`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: token ? 'omit' : 'include',
          body: form
        })
        const json = (await res.json().catch(() => ({}))) as {
          data?: DroppedDoc
          error?: string
        }
        if (!res.ok || !json.data) throw new Error(json.error || `Could not read ${file.name}`)
        const doc = json.data
        setDocs((prev) => [...prev, doc])
      } catch (err) {
        setError(err instanceof Error ? err.message : `Could not read ${file.name}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
    if (files.length > room) setError(`At most ${MAX_DOCS} files per conversation`)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const rec = readDroppedRecord(e.dataTransfer)
    if (rec) {
      setRecords((prev) =>
        prev.some((r) => r.collection === rec.collection && r.id === rec.id) ||
        prev.length >= MAX_RECORDS
          ? prev
          : [...prev, rec]
      )
      return
    }
    const files = [...e.dataTransfer.files]
    if (files.length) void upload(files)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (lastQuestion) ask(lastQuestion, { fresh: true })
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      ask()
      return
    }
    if (e.key === 'ArrowUp' && !input && lastQuestion) {
      e.preventDefault()
      setInput(lastQuestion)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (send.active) void send.stop()
      else host.setOpen(false)
    }
  }

  function newConversation() {
    if (send.active) return
    setTurns([])
    setConversationId(null)
    setRecords([])
    setDocs([])
    setError(null)
    boxRef.current?.focus()
  }

  const chips: Array<{ key: string; icon: ReactNode; label: string; onRemove: () => void }> = []
  const dismiss = (k: keyof AskPageContext) => setDismissed((prev) => new Set(prev).add(k))
  if (page?.record && !dismissed.has('record'))
    chips.push({
      key: 'record',
      icon: <FileText className='h-3 w-3' />,
      label: page.record.label || `${page.record.collection} ${page.record.id}`,
      onRemove: () => dismiss('record')
    })
  if (page?.list && !dismissed.has('list'))
    chips.push({
      key: 'list',
      icon: <Rows3 className='h-3 w-3' />,
      label: `${page.list.label || page.list.collection} · ${page.list.ids.length} on screen${page.list.filters.length ? ` · ${page.list.filters.length} filter(s)` : ''}`,
      onRemove: () => dismiss('list')
    })
  if (page?.queue && !dismissed.has('queue'))
    chips.push({
      key: 'queue',
      icon: <ListChecks className='h-3 w-3' />,
      label: `${page.queue.label || 'Queue'} · ${page.queue.items.length} on screen`,
      onRemove: () => dismiss('queue')
    })
  if (page?.report && !dismissed.has('report'))
    chips.push({
      key: 'report',
      icon: <LayoutDashboard className='h-3 w-3' />,
      label: `${page.report.label || 'Report'}${page.report.entity_filters?.length ? ` · ${page.report.entity_filters.length} filter(s)` : ''}`,
      onRemove: () => dismiss('report')
    })
  for (const r of records)
    chips.push({
      key: `rec:${r.collection}:${r.id}`,
      icon: <FileText className='h-3 w-3' />,
      label: r.label || `${r.collection} ${r.id}`,
      onRemove: () =>
        setRecords((prev) => prev.filter((x) => !(x.collection === r.collection && x.id === r.id)))
    })
  for (const d of docs)
    chips.push({
      key: `doc:${d.id}`,
      icon: <Paperclip className='h-3 w-3' />,
      label: `${d.name}${d.truncated ? ' (long — first part)' : ''}`,
      onRemove: () => setDocs((prev) => prev.filter((x) => x.id !== d.id))
    })

  return (
    <aside
      data-ask-panel
      aria-label='Ask AI'
      hidden={!host.open}
      className={cn(
        'fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-full flex-col border-l border-border bg-background text-foreground shadow-2xl',
        !host.open && 'hidden',
        dragOver && 'ring-2 ring-inset ring-nvr-cyan'
      )}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <header className='flex shrink-0 items-center gap-2 border-b border-border px-3 py-2'>
        <Sparkles className='h-4 w-4 text-nvr-cyan' />
        <span className='text-[13px] font-semibold'>Ask AI</span>
        <span className='text-[11px] text-muted-foreground'>⌘J</span>
        <div className='ml-auto flex items-center gap-1'>
          {conversationId && (
            <button
              type='button'
              data-ask-panel-open-full
              onClick={() => {
                host.setOpen(false)
                navigate(`${askPath}?conversation=${conversationId}`)
              }}
              className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground'
            >
              <ExternalLink className='h-3.5 w-3.5' /> Open in Ask AI
            </button>
          )}
          <button
            type='button'
            onClick={newConversation}
            disabled={send.active}
            aria-label='New conversation'
            data-tip='New conversation'
            className='inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50'
          >
            <Plus className='h-4 w-4' />
          </button>
          <button
            type='button'
            onClick={() => host.setOpen(false)}
            aria-label='Close Ask AI'
            className='inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground'
          >
            <X className='h-4 w-4' />
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className='min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3'
      >
        {turns.length === 0 && !send.active && (
          <div className='space-y-2 pt-6 text-center text-[12.5px] text-muted-foreground'>
            <p>Ask about what is on this page — the chips below say what rides along.</p>
            <p className='text-[11.5px]'>
              Drop records or a PDF, Word or Excel file here to ask about them too.
            </p>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: turns only append; the index is stable
            <div key={i} className='flex justify-end'>
              <div className='max-w-[85%] whitespace-pre-wrap rounded-lg bg-nvr-cyan/10 px-3 py-2 text-[13px]'>
                {t.content}
              </div>
            </div>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: turns only append; the index is stable
            <div key={i} className='space-y-1'>
              <AiMarkdown content={t.content} className='text-[13px]' />
              <div className='flex items-center gap-2'>
                {t.stopped && <span className='text-[11px] text-muted-foreground'>Stopped</span>}
                <AiFeedbackButtons requestId={t.requestId} />
              </div>
            </div>
          )
        )}
        {send.active && (
          <div data-ask-panel-streaming className='space-y-1.5'>
            <AiStepList steps={send.steps} folded={!!send.text} />
            {send.text ? (
              <AiMarkdown content={send.text} className='text-[13px]' />
            ) : (
              <p className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
                <Loader2 className='h-3.5 w-3.5 animate-spin' /> {send.status ?? 'Thinking…'}
              </p>
            )}
          </div>
        )}
        {error && (
          <p className='rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[12px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'>
            {error}
          </p>
        )}
      </div>

      <footer className='shrink-0 space-y-2 border-t border-border px-3 py-2.5'>
        {(chips.length > 0 || uploading > 0) && (
          <div className='flex flex-wrap gap-1.5' data-ask-panel-chips>
            {chips.map((c) => (
              <span
                key={c.key}
                className='inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11.5px]'
              >
                {c.icon}
                <span className='truncate'>{c.label}</span>
                <button
                  type='button'
                  onClick={c.onRemove}
                  aria-label={`Remove ${c.label}`}
                  className='rounded-full text-muted-foreground hover:text-foreground'
                >
                  <X className='h-3 w-3' />
                </button>
              </span>
            ))}
            {uploading > 0 && (
              <span className='inline-flex items-center gap-1 text-[11.5px] text-muted-foreground'>
                <Loader2 className='h-3 w-3 animate-spin' /> Reading file…
              </span>
            )}
          </div>
        )}
        {record && (offeredFiles?.length ?? 0) > 0 && (
          <div className='space-y-1' data-ask-panel-record-files>
            <p className='text-[11px] font-medium text-muted-foreground'>
              Attachments on this record — use as sources
            </p>
            <div className='flex flex-wrap gap-1.5'>
              {offeredFiles!.map((f) => {
                const on = recordFiles.includes(f.id)
                return (
                  <button
                    key={f.id}
                    type='button'
                    aria-pressed={on}
                    onClick={() =>
                      setRecordFiles((prev) =>
                        on
                          ? prev.filter((x) => x !== f.id)
                          : prev.length >= MAX_DOCS
                            ? prev
                            : [...prev, f.id]
                      )
                    }
                    className={cn(
                      'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px]',
                      on
                        ? 'border-nvr-cyan bg-nvr-cyan/10 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    )}
                  >
                    <Paperclip className='h-3 w-3' />
                    <span className='truncate'>{f.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <div className='flex items-end gap-1.5'>
          <button
            type='button'
            onClick={() => fileRef.current?.click()}
            disabled={docs.length >= MAX_DOCS}
            aria-label='Attach a file'
            data-tip='Attach a PDF, Word or Excel file'
            className='inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50'
          >
            <Paperclip className='h-4 w-4' />
          </button>
          <input
            ref={fileRef}
            type='file'
            accept={ACCEPT}
            multiple
            className='hidden'
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              if (files.length) void upload(files)
            }}
          />
          <textarea
            ref={boxRef}
            data-ask-panel-input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder='Ask about this page…'
            className='min-h-[38px] flex-1 resize-none rounded-md border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-nvr-cyan'
          />
          {send.active ? (
            <button
              type='button'
              onClick={() => void send.stop()}
              aria-label='Stop the answer'
              className='inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border hover:bg-muted'
            >
              <Square className='h-3.5 w-3.5' />
            </button>
          ) : (
            <button
              type='button'
              onClick={() => ask()}
              disabled={!input.trim() || uploading > 0}
              aria-label='Ask'
              className='inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-nvr-cyan text-white disabled:opacity-50'
            >
              <Send className='h-4 w-4' />
            </button>
          )}
        </div>
        <p className='text-[10.5px] text-muted-foreground'>
          Enter asks · ↑ last question · Esc stops · ⌘↵ asks again
        </p>
      </footer>
    </aside>
  )
}
