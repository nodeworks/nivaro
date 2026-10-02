/**
 * Investigation panel header actions (drill-down Task 8):
 *  - Explain (#1210): the stack's context → POST /traffic-map/inspect/explain → three short
 *    sections with [L2]-style citations that jump to that level.
 *  - Share (#1211): create an issue (POST /issues) or post to a chat room (POST /chat/messages),
 *    each carrying the Markdown summary and the `inspect` link.
 *  - Save investigation (#1212): POST /traffic-map/investigations (stack + context).
 *  - Export (#1215): Markdown (copy / download) and HAR (request levels only).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookmarkPlus,
  ClipboardCopy,
  Download,
  FileJson,
  FileText,
  MessageSquare,
  Send,
  Sparkles,
  TriangleAlert
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { refTitle } from '../../inspect/format'
import { encodeStack, getInspectSnapshot, goTo, openInspect } from '../../inspect/stack'
import type { InspectPanelProps } from '../../registry/inspectables'
import { buildStackContext, exportLevels } from './context'
import {
  buildChatSummary,
  buildHar,
  buildMarkdown,
  citeParts,
  exportFileName,
  parseExplain,
  type RequestFacts,
  requestFacts
} from './logic'
import {
  apiErrorOf,
  copyText,
  downloadText,
  FIELD,
  ICON_BTN,
  ICON_BTN_ON,
  MENU_ITEM,
  MUTED,
  POP,
  useInspectStack
} from './ui'

const PRIMARY =
  'inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--tm-accent)] px-2.5 py-1 text-[12px] font-medium text-[#0f172a] transition-colors duration-150 ease-out hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-50'
const SECONDARY =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 py-1 text-[12px] font-medium text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-50'

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

// ── Explain (#1210) ──

interface ExplainResult {
  text: string
  sentBytes: number
  trimmed: string[]
  levels: number
}

function ExplainBody({ result }: { result: ExplainResult }) {
  const s = useInspectStack()
  const sections = parseExplain(result.text)
  return (
    <div className='grid gap-2.5' data-tm-inspect-explain-result=''>
      {sections.map((sec, i) => (
        <section key={`${sec.title ?? 'text'}-${i}`} className='grid gap-0.5'>
          {sec.title && (
            <h4 className='text-[12px] font-semibold text-[var(--tm-fg-2)]'>{sec.title}</h4>
          )}
          <p className='leading-relaxed'>
            {citeParts(sec.body).map((p, k) => {
              if ('text' in p) return <span key={k}>{p.text}</span>
              const idx = p.level - 1
              const ref = s.levels[idx]
              if (!ref)
                return (
                  <span key={k} className={MUTED}>
                    [L{p.level}]
                  </span>
                )
              const isCurrent = idx === s.index
              return (
                <button
                  key={k}
                  type='button'
                  disabled={isCurrent || idx > s.index}
                  onClick={() => goTo(idx)}
                  data-tip={isCurrent ? `${refTitle(ref)} (on screen)` : `Go to ${refTitle(ref)}`}
                  data-tm-inspect-explain-cite={p.level}
                  className='mx-0.5 rounded bg-[var(--tm-card-2)] px-1 text-[11px] font-medium text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:no-underline disabled:opacity-80'
                >
                  L{p.level}
                </button>
              )
            })}
          </p>
        </section>
      ))}
      <p className={MUTED}>
        Sent {result.levels} level{result.levels === 1 ? '' : 's'} ({kb(result.sentBytes)})
        {result.trimmed.length > 0 ? ` — trimmed ${result.trimmed.join(', ')} to fit` : ''}. Checked
        by AI, not by a person: verify before acting.
      </p>
    </div>
  )
}

export function ExplainAction(_props: InspectPanelProps) {
  const qc = useQueryClient()
  const s = useInspectStack()
  const key = encodeStack(s.levels) ?? ''
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<Record<string, ExplainResult>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null)
  const result = results[key]

  const run = async () => {
    const snap = getInspectSnapshot()
    const stackKey = encodeStack(snap.levels) ?? ''
    const built = buildStackContext(qc, snap)
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/traffic-map/inspect/explain', { context: built.context })
      const text = String((res.data as { data?: { text?: string } })?.data?.text ?? '')
      setResults((r) => ({
        ...r,
        [stackKey]: {
          text,
          sentBytes: built.bytes,
          trimmed: built.trimmed,
          levels: built.context.levels.length
        }
      }))
    } catch (e) {
      const err = apiErrorOf(e)
      setError({ code: err.code, message: err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o && !results[key] && !busy) void run()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(ICON_BTN, open && ICON_BTN_ON)}
          aria-label='Explain this investigation'
          data-tip='Explain with AI: what happened, the likely cause, where to look next'
          data-tm-inspect-explain=''
        >
          <Sparkles className='h-4 w-4' aria-hidden='true' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className={cn(POP, 'w-[380px]')}>
        <div className='grid gap-2.5' data-tm-inspect-explain-panel=''>
          <p className='text-[12.5px] font-semibold'>Explain this investigation</p>
          {busy && (
            <div className='grid gap-2' aria-busy='true' data-tm-inspect-explain-loading=''>
              {[92, 78, 85, 60].map((w) => (
                <div
                  key={w}
                  className='h-3 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          )}
          {!busy && error && (
            <div className='grid gap-2' data-tm-inspect-explain-error={error.code ?? ''}>
              <p className='flex items-start gap-1.5 text-[var(--tm-error-ink)]'>
                <TriangleAlert className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden='true' />
                {error.code === 'AI_NOT_CONFIGURED'
                  ? 'No AI provider is set up, so nothing can explain this yet. An administrator can add one in Settings → AI Features.'
                  : error.message}
              </p>
              {error.code !== 'AI_NOT_CONFIGURED' && (
                <button type='button' className={SECONDARY} onClick={() => void run()}>
                  Try again
                </button>
              )}
            </div>
          )}
          {!busy && !error && result && <ExplainBody result={result} />}
          {!busy && result && (
            <button
              type='button'
              className={SECONDARY}
              onClick={() => void run()}
              data-tm-inspect-explain-again=''
            >
              Explain again
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── Share: issue / chat (#1211) ──

const SEVERITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' }
]

interface ChatRoom {
  room: string
  kind: string
  label: string | null
  archived?: boolean
}

function roomLabel(r: ChatRoom): string {
  if (r.label) return r.label
  if (r.room === 'global') return 'General'
  if (r.kind === 'dm') return 'Direct message'
  return r.room
}

function IssueForm({ onDone }: { onDone(): void }) {
  const qc = useQueryClient()
  const s = useInspectStack()
  const root = s.levels[0]
  const [title, setTitle] = useState(() => (root ? `Traffic Map: ${refTitle(root)}` : ''))
  const [severity, setSeverity] = useState('medium')
  const [busy, setBusy] = useState(false)
  const create = async () => {
    const snap = getInspectSnapshot()
    const levels = exportLevels(qc, snap)
    const md = buildMarkdown(levels, { anchor: snap.anchor, now: Date.now() })
    setBusy(true)
    try {
      const res = await api.post('/issues', {
        title: title.trim(),
        severity,
        details: `${levels[levels.length - 1]?.url ?? ''}\n\n${md}`.slice(0, 8000)
      })
      const id = (res.data as { data?: { id?: number } })?.data?.id
      toast.success(id ? `Issue #${id} created` : 'Issue created', {
        description: 'It is on the Issues page with this investigation attached.'
      })
      onDone()
    } catch (e) {
      toast.error(apiErrorOf(e).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='grid gap-2' data-tm-inspect-issue-form=''>
      <label className='grid gap-1'>
        <span className='text-[12px] font-medium text-[var(--tm-fg-2)]'>Title</span>
        <input
          className={FIELD}
          value={title}
          maxLength={500}
          onChange={(e) => setTitle(e.target.value)}
          data-tm-inspect-issue-title=''
        />
      </label>
      <div className='grid gap-1'>
        <span className='text-[12px] font-medium text-[var(--tm-fg-2)]'>Severity</span>
        <SimpleSelect
          value={severity}
          onChange={setSeverity}
          options={SEVERITIES}
          ariaLabel='Severity'
          className='h-8 text-[12.5px]'
          triggerProps={{ 'data-tm-inspect-issue-severity': '' }}
        />
      </div>
      <p className={MUTED}>
        The details hold every level's key facts as Markdown and a link back to this view.
      </p>
      <div className='flex justify-end gap-2'>
        <button type='button' className={SECONDARY} onClick={onDone}>
          Cancel
        </button>
        <button
          type='button'
          className={PRIMARY}
          disabled={busy || !title.trim()}
          onClick={() => void create()}
          data-tm-inspect-issue-create=''
        >
          {busy ? 'Creating…' : 'Create issue'}
        </button>
      </div>
    </div>
  )
}

function ChatForm({ onDone }: { onDone(): void }) {
  const qc = useQueryClient()
  const [room, setRoom] = useState<ChatRoom | null>(null)
  const [busy, setBusy] = useState(false)
  const rooms = useQuery({
    queryKey: ['traffic-map', 'inspect-chat-rooms'],
    queryFn: async () => ((await api.get('/chat/rooms')).data as { data?: ChatRoom[] })?.data ?? [],
    staleTime: 60_000
  })
  const snap = getInspectSnapshot()
  const preview = buildChatSummary(exportLevels(qc, snap))
  const post = async () => {
    if (!room) return
    setBusy(true)
    try {
      await api.post('/chat/messages', { room: room.room, message: preview })
      toast.success(`Posted to ${roomLabel(room)}`)
      onDone()
    } catch (e) {
      toast.error(apiErrorOf(e).message)
    } finally {
      setBusy(false)
    }
  }
  const list = (rooms.data ?? []).filter((r) => !r.archived)
  return (
    <div className='grid gap-2' data-tm-inspect-chat-form=''>
      {room ? (
        <>
          <p className='text-[12px] text-[var(--tm-fg-2)]'>
            To <span className='font-semibold text-[var(--tm-fg)]'>{roomLabel(room)}</span>{' '}
            <button
              type='button'
              className='text-[var(--tm-accent-ink)] hover:underline'
              onClick={() => setRoom(null)}
            >
              change
            </button>
          </p>
          <pre className='max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--tm-card-2)] p-2 text-[11.5px]'>
            {preview}
          </pre>
          <div className='flex justify-end gap-2'>
            <button type='button' className={SECONDARY} onClick={onDone}>
              Cancel
            </button>
            <button
              type='button'
              className={PRIMARY}
              disabled={busy}
              onClick={() => void post()}
              data-tm-inspect-chat-post=''
            >
              {busy ? 'Posting…' : 'Post'}
            </button>
          </div>
        </>
      ) : rooms.isLoading ? (
        <div className='grid gap-1.5' aria-busy='true'>
          {[80, 64, 72].map((w) => (
            <div
              key={w}
              className='h-3 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      ) : rooms.isError ? (
        <p className='text-[var(--tm-error-ink)]'>
          Your chat rooms could not be loaded: {apiErrorOf(rooms.error).message}
        </p>
      ) : (
        <Command className='bg-transparent' data-tm-inspect-chat-rooms=''>
          <CommandInput placeholder='Find a room…' />
          <CommandList className='max-h-56'>
            <CommandEmpty>
              {list.length === 0
                ? 'You are not in any chat room yet. Join one from Chat first.'
                : 'No room matches.'}
            </CommandEmpty>
            {list.map((r) => (
              <CommandItem
                key={r.room}
                value={`${roomLabel(r)} ${r.room}`}
                onSelect={() => setRoom(r)}
                data-tm-inspect-chat-room={r.room}
              >
                {roomLabel(r)}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      )}
    </div>
  )
}

export function ShareAction(_props: InspectPanelProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'menu' | 'issue' | 'chat'>('menu')
  const close = () => {
    setOpen(false)
    setView('menu')
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setView('menu')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(ICON_BTN, open && ICON_BTN_ON)}
          aria-label='Share this investigation'
          data-tip='Create an issue or post to chat'
          data-tm-inspect-share=''
        >
          <Send className='h-4 w-4' aria-hidden='true' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className={cn(POP, view === 'menu' ? 'w-[220px] p-1' : 'w-[340px]')}
      >
        {view === 'menu' && (
          <div className='grid' data-tm-inspect-share-menu=''>
            <button
              type='button'
              className={MENU_ITEM}
              onClick={() => setView('issue')}
              data-tm-inspect-share-issue=''
            >
              <TriangleAlert className='h-3.5 w-3.5 text-[var(--tm-muted)]' aria-hidden='true' />
              Create issue…
            </button>
            <button
              type='button'
              className={MENU_ITEM}
              onClick={() => setView('chat')}
              data-tm-inspect-share-chat=''
            >
              <MessageSquare className='h-3.5 w-3.5 text-[var(--tm-muted)]' aria-hidden='true' />
              Post to chat…
            </button>
          </div>
        )}
        {view === 'issue' && <IssueForm onDone={close} />}
        {view === 'chat' && <ChatForm onDone={close} />}
      </PopoverContent>
    </Popover>
  )
}

// ── Save investigation (#1212) ──

export function SaveAction(_props: InspectPanelProps) {
  const qc = useQueryClient()
  const s = useInspectStack()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const root = s.levels[0]
  const save = async () => {
    const snap = getInspectSnapshot()
    const stack = encodeStack(snap.levels)
    if (!stack) return
    const built = buildStackContext(qc, snap)
    setBusy(true)
    try {
      const res = await api.post('/traffic-map/investigations', {
        title: title.trim() || (root ? refTitle(root) : 'Investigation'),
        stack,
        notes: notes.trim() || undefined,
        context: built.context
      })
      const made = (res.data as { data?: { id: string; title: string } })?.data
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'investigations'] })
      setOpen(false)
      setTitle('')
      setNotes('')
      toast.success(`Saved "${made?.title ?? 'investigation'}"`, {
        description: 'Find it under Investigations in the toolbar.',
        action: made
          ? {
              label: 'Open',
              onClick: () => openInspect({ kind: 'notebook', id: made.id, label: made.title })
            }
          : undefined
      })
    } catch (e) {
      toast.error(apiErrorOf(e).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(ICON_BTN, open && ICON_BTN_ON)}
          aria-label='Save investigation'
          data-tip='Save this investigation to a notebook'
          data-tm-inspect-save=''
        >
          <BookmarkPlus className='h-4 w-4' aria-hidden='true' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className={cn(POP, 'w-[320px]')}>
        <div className='grid gap-2' data-tm-inspect-save-form=''>
          <p className='text-[12.5px] font-semibold'>Save investigation</p>
          <input
            className={FIELD}
            placeholder={root ? refTitle(root) : 'Title'}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            aria-label='Title'
            data-tm-inspect-save-title=''
          />
          <textarea
            className={cn(FIELD, 'min-h-[64px] resize-y')}
            placeholder='Notes (optional)'
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            aria-label='Notes'
            data-tm-inspect-save-notes=''
          />
          <p className={MUTED}>
            Keeps the {s.levels.length} open level{s.levels.length === 1 ? '' : 's'} and what each
            one showed, so it still reads after the data ages out.
          </p>
          <div className='flex justify-end'>
            <button
              type='button'
              className={PRIMARY}
              disabled={busy || s.levels.length === 0}
              onClick={() => void save()}
              data-tm-inspect-save-submit=''
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── Export (#1215) ──

export function ExportAction(_props: InspectPanelProps) {
  const qc = useQueryClient()
  const s = useInspectStack()
  const [open, setOpen] = useState(false)
  // computed while open so the counts match what the panels have loaded right now
  const levels = open ? exportLevels(qc, s) : []
  const requestLevels = levels.filter((l) => l.ref.kind === 'request')
  const facts: RequestFacts[] = []
  for (const l of requestLevels) {
    const f = requestFacts(l.detail, l.ref)
    if (f) facts.push(f)
  }
  const missing = requestLevels.length - facts.length
  const markdown = () => buildMarkdown(levels, { anchor: s.anchor, now: Date.now() })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(ICON_BTN, open && ICON_BTN_ON)}
          aria-label='Export this investigation'
          data-tip='Export as Markdown or HAR'
          data-tm-inspect-export=''
        >
          <Download className='h-4 w-4' aria-hidden='true' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className={cn(POP, 'w-[260px] p-1')}>
        <div className='grid' data-tm-inspect-export-menu=''>
          <button
            type='button'
            className={MENU_ITEM}
            data-tm-inspect-export-copy=''
            onClick={async () => {
              const ok = await copyText(markdown())
              if (ok) toast.success('Markdown copied')
              else toast.error('The browser blocked the clipboard. Download it instead.')
              setOpen(false)
            }}
          >
            <ClipboardCopy className='h-3.5 w-3.5 text-[var(--tm-muted)]' aria-hidden='true' />
            Copy as Markdown
          </button>
          <button
            type='button'
            className={MENU_ITEM}
            data-tm-inspect-export-md=''
            onClick={() => {
              downloadText(exportFileName('md', Date.now()), markdown(), 'text/markdown')
              setOpen(false)
            }}
          >
            <FileText className='h-3.5 w-3.5 text-[var(--tm-muted)]' aria-hidden='true' />
            Download Markdown
          </button>
          <button
            type='button'
            className={MENU_ITEM}
            disabled={facts.length === 0}
            data-tm-inspect-export-har=''
            data-tip={
              requestLevels.length === 0
                ? 'HAR needs a request in the stack — open one first'
                : facts.length === 0
                  ? 'The request levels have not loaded yet'
                  : undefined
            }
            onClick={() => {
              const har = buildHar(facts, window.location.origin)
              downloadText(
                exportFileName('har', Date.now()),
                JSON.stringify(har, null, 2),
                'application/json'
              )
              setOpen(false)
            }}
          >
            <FileJson className='h-3.5 w-3.5 text-[var(--tm-muted)]' aria-hidden='true' />
            Download HAR
            {facts.length > 0 && (
              <span className='ml-auto text-[11px] text-[var(--tm-muted)]'>
                {facts.length} request{facts.length === 1 ? '' : 's'}
              </span>
            )}
          </button>
          {missing > 0 && facts.length > 0 && (
            <p className={cn(MUTED, 'px-2 pb-1')}>
              {missing} request level{missing === 1 ? ' has' : 's have'} not loaded and will be left
              out.
            </p>
          )}
          {requestLevels.length === 0 && (
            <p className={cn(MUTED, 'px-2 pb-1')}>HAR covers requests only; this stack has none.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
