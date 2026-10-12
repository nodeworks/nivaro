import { createNivaro } from '@nivaro/sdk'
import {
  AiFeedbackButtons,
  AiMarkdown,
  type AiMemorySuggestion,
  AiMemorySuggestions,
  type AiPlan,
  AiPlanCard,
  type AiPlanSubscribe,
  AiStepList,
  type AiStreamSubscribe,
  NavigationContext,
  NivaroProvider,
  useAiStream
} from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Download,
  GitBranch,
  History,
  Loader2,
  Lock,
  Mic,
  Pencil,
  Pin,
  PinOff,
  Send,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  Wrench
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { MyWatchesPanel, WatchThisNumber, watchableAggregate } from '@/components/ask-watches'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { ASK_HANDOFF_KEY } from '@/lib/ask-handoff'
import { useAuth } from '@/lib/auth'
import { getSocket } from '@/lib/socket'
import { cn, formatRelative } from '@/lib/utils'
import { ASK_LIST_KEY, AskHistory } from './ask/AskHistory'
import { PostToChatMenu, ShareMenu, type ShareRow } from './ask/AskShare'

interface TraceEntry {
  tool: string
  input: Record<string, unknown>
  summary: string
}

interface Proposal {
  proposal_id: string
  action_type: 'bulk_update' | 'create_record' | 'create_dashboard' | 'create_task'
  collection: string
  count: number
  changes: Record<string, unknown> | null
  sample: Array<{ id: string; label: string }>
  widgets?: Array<{ type: string; title: string; collection: string; field: string | null }>
  /** Live outcome, when the turn came back from history (#1833). */
  status?: string
}

interface ChatTurn {
  /** Stored message id (#1833) — absent on a turn still being asked. */
  id?: string
  role: 'user' | 'assistant'
  content: string
  trace?: TraceEntry[]
  proposals?: Proposal[]
  /** Multi-step plans (#1807) — the card re-reads each from the server. */
  plans?: AiPlan[]
  /** "Remember this?" offers (#1845) — only ever on the asker's own answers. */
  memorySuggestions?: AiMemorySuggestion[]
  requestId?: string | null
  playbooksUsed?: number
  /** Served from the answer cache (#723) — when it was first answered. */
  cachedAt?: string | null
  /** Stopped by the person before the model finished (#688). */
  stopped?: boolean
  /** Who asked / whose access answered (shared threads, #1809). */
  author?: { id: string; name: string } | null
  /** False = an answer given with someone else's access that this reader may not see. */
  visible?: boolean
}

interface ChatBody {
  reply: string
  trace: TraceEntry[]
  proposals?: Proposal[]
  plans?: AiPlan[]
  request_id?: string | null
  playbooks_used?: number
  cached?: boolean
  cached_at?: string
  stopped?: boolean
  /** #1833 — the stored conversation this answer was kept in. */
  conversation_id?: string
  /** #1804 — a "remember that …" note was kept instead of asking. */
  remembered?: { id: string; text: string }
  /** #1845 — notes the model offers to remember; saved only on a click. */
  memory_suggestions?: AiMemorySuggestion[]
}

interface ServerMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  author: { id: string; name: string } | null
  created_at: string
  visible: boolean
  own: boolean
  trace: TraceEntry[]
  proposals: Proposal[]
  meta: Record<string, unknown>
}

interface ConversationDetail {
  conversation: {
    id: string
    title: string
    pinned: boolean
    parent_id: string | null
    branch_from: string | null
    owner: { id: string; name: string }
    access: 'owner' | 'shared' | 'room'
    link: string
  }
  messages: ServerMessage[]
  shares: ShareRow[]
  branches: Array<{ id: string; title: string; branch_from: string | null; created_at: string }>
  parent: { id: string; title: string } | null
}

/** Tools whose rows an answer can export (#1841) — the server re-runs them as the reader. */
const EXPORTABLE_TOOLS = new Set([
  'query_items',
  'aggregate',
  'semantic_search',
  'run_custom_query',
  'queue_summary',
  'record_event_path',
  'record_integrity',
  'integration_status'
])

// The answer streams over the shared admin socket (#688): the route emits
// ai:delta / ai:status / ai:done / ai:error to the user's own room, so every
// tab of theirs hears it and this one pairs the events to its stream id.
const subscribeAi: AiStreamSubscribe = (event, handler) => {
  const s = getSocket()
  s.on(event, handler)
  return () => {
    s.off(event, handler)
  }
}

// Plan progress (#2007) rides the same socket: `ai:plan` to the user's room.
const subscribePlan: AiPlanSubscribe = (event, handler) => {
  const s = getSocket()
  s.on(event, handler)
  return () => {
    s.off(event, handler)
  }
}

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

const SUGGESTIONS = [
  'How many records are in each collection?',
  'What changed in the last 7 days?',
  'Show the 5 most recent workflows and their states'
]

const detailKey = (id: string | null) => ['ask-conversation', id] as const

const fetchDetail = (id: string) =>
  api.get<{ data: ConversationDetail }>(`/ai/conversations/${id}`).then((r) => r.data.data)

function toTurn(m: ServerMessage): ChatTurn {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    trace: m.trace,
    proposals: m.proposals,
    plans: m.own && Array.isArray(m.meta.plans) ? (m.meta.plans as AiPlan[]) : undefined,
    memorySuggestions:
      m.own && Array.isArray(m.meta.memory_suggestions)
        ? (m.meta.memory_suggestions as AiMemorySuggestion[])
        : undefined,
    requestId: typeof m.meta.request_id === 'string' ? m.meta.request_id : null,
    playbooksUsed: Number(m.meta.playbooks_used ?? 0),
    cachedAt: typeof m.meta.cached_at === 'string' ? m.meta.cached_at : null,
    stopped: m.meta.stopped === true,
    author: m.author,
    visible: m.visible
  }
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const initial =
    proposal.status === 'executed' || proposal.status === 'rejected'
      ? proposal.status
      : proposal.status && proposal.status !== 'proposed'
        ? 'error'
        : 'proposed'
  const [status, setStatus] = useState<'proposed' | 'working' | 'executed' | 'rejected' | 'error'>(
    initial
  )
  const [resultText, setResultText] = useState(
    initial === 'executed'
      ? 'Done'
      : initial === 'error'
        ? `No longer open (${proposal.status})`
        : ''
  )

  async function decide(action: 'approve' | 'reject') {
    setStatus('working')
    try {
      if (action === 'reject') {
        await api.post(`/ai/proposals/${proposal.proposal_id}/reject`)
        setStatus('rejected')
        return
      }
      const r = await api.post<{ data: { result: Record<string, unknown> } }>(
        `/ai/proposals/${proposal.proposal_id}/approve`
      )
      const res = r.data.data.result
      setResultText(
        proposal.action_type === 'create_dashboard'
          ? `Created dashboard — open /dashboards/${String(res.dashboard_id ?? '')}`
          : proposal.action_type === 'create_task'
            ? `Task created on ${proposal.sample[0]?.label ?? 'the record'}`
            : proposal.action_type === 'create_record'
              ? `Created record ${String(res.id ?? '')}`
              : `Updated ${String(res.updated)} record(s)${Number(res.failed) > 0 ? `, ${String(res.failed)} failed` : ''}`
      )
      setStatus('executed')
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setResultText(msg ?? 'Failed')
      setStatus('error')
    }
  }

  return (
    <div className='mt-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-800 dark:bg-amber-900/10'>
      <p className='text-[12px] font-semibold text-amber-800 dark:text-amber-300'>
        {proposal.action_type === 'create_dashboard'
          ? `Proposed: create dashboard “${String(proposal.changes?.name ?? '')}” with ${proposal.count} widget${proposal.count !== 1 ? 's' : ''}`
          : proposal.action_type === 'create_task'
            ? `Proposed: a task on ${proposal.sample[0]?.label ?? 'the record'}`
            : proposal.action_type === 'create_record'
              ? `Proposed: create a ${proposal.collection} record`
              : `Proposed: update ${proposal.count} ${proposal.collection} record${proposal.count !== 1 ? 's' : ''}`}
      </p>
      {proposal.widgets && proposal.widgets.length > 0 && (
        <div className='mt-1.5 space-y-0.5'>
          {proposal.widgets.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static preview
            <p key={i} className='text-[11.5px] text-amber-900 dark:text-amber-200'>
              <code className='font-mono'>{w.type}</code> — {w.title}{' '}
              <span className='text-amber-700/70'>
                ({w.collection}
                {w.field ? `.${w.field}` : ''})
              </span>
            </p>
          ))}
        </div>
      )}
      {proposal.action_type !== 'create_dashboard' && proposal.changes && (
        <div className='mt-1.5 space-y-0.5'>
          {Object.entries(proposal.changes).map(([k, v]) => (
            <p key={k} className='text-[11.5px] text-amber-900 dark:text-amber-200'>
              <code className='font-mono'>{k}</code> → <strong>{String(v)}</strong>
            </p>
          ))}
        </div>
      )}
      {proposal.action_type !== 'create_task' && proposal.sample.length > 0 && (
        <p className='mt-1.5 truncate text-[11px] text-amber-700/80 dark:text-amber-400/80'>
          e.g.{' '}
          {proposal.sample
            .slice(0, 4)
            .map((sMpl) => sMpl.label)
            .join(' · ')}
          {proposal.count > 4 ? ` +${proposal.count - 4} more` : ''}
        </p>
      )}
      <div className='mt-2 flex items-center gap-2'>
        {status === 'proposed' && (
          <>
            <Button size='sm' className='h-7' onClick={() => decide('approve')}>
              Approve & run
            </Button>
            <Button size='sm' variant='outline' className='h-7' onClick={() => decide('reject')}>
              Reject
            </Button>
          </>
        )}
        {status === 'working' && (
          <span className='flex items-center gap-1.5 text-[12px] text-amber-700'>
            <Loader2 className='h-3 w-3 animate-spin' /> Executing…
          </span>
        )}
        {status === 'executed' && (
          <span className='text-[12px] font-medium text-green-700 dark:text-green-400'>
            ✓ {resultText}
          </span>
        )}
        {status === 'rejected' && (
          <span className='text-[12px] text-slate-500'>Rejected — nothing changed.</span>
        )}
        {status === 'error' && <span className='text-[12px] text-red-600'>✗ {resultText}</span>}
      </div>
    </div>
  )
}

/** CSV / Excel of the rows behind an answer (#1841) — the query re-runs as you. */
function ExportButtons({
  conversationId,
  messageId
}: {
  conversationId: string
  messageId: string
}) {
  const [busy, setBusy] = useState<'csv' | 'xlsx' | null>(null)
  async function download(format: 'csv' | 'xlsx') {
    setBusy(format)
    try {
      const r = await api.get(`/ai/conversations/${conversationId}/messages/${messageId}/export`, {
        params: { format },
        responseType: 'blob'
      })
      const disposition = String(r.headers['content-disposition'] ?? '')
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `ask-ai-answer.${format}`
      const url = URL.createObjectURL(r.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      let msg = 'Export failed'
      const data = (err as { response?: { data?: unknown } })?.response?.data
      if (data instanceof Blob) {
        try {
          msg = (JSON.parse(await data.text()) as { error?: string }).error ?? msg
        } catch {
          // keep the generic message
        }
      }
      toast.error(msg)
    } finally {
      setBusy(null)
    }
  }
  return (
    <span className='flex items-center gap-0.5' data-ask-export>
      {(['csv', 'xlsx'] as const).map((f) => (
        <button
          key={f}
          type='button'
          onClick={() => void download(f)}
          disabled={busy != null}
          className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-slate-500 hover:bg-muted hover:text-slate-800 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-200'
          data-tip='Re-runs the query with your access and downloads the rows'
        >
          {busy === f ? (
            <Loader2 className='h-3 w-3 animate-spin' />
          ) : (
            <Download className='h-3 w-3' />
          )}
          {f === 'csv' ? 'CSV' : 'Excel'}
        </button>
      ))}
    </span>
  )
}

function AskPageInner() {
  const qc = useQueryClient()
  const { user: me } = useAuth()
  const [pending, setPending] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const conversationId = searchParams.get('conversation')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)

  const { data: detail, error: detailError } = useQuery({
    queryKey: detailKey(conversationId),
    queryFn: () => fetchDetail(conversationId as string),
    enabled: !!conversationId,
    retry: false
  })
  const turns: ChatTurn[] = [...(detail?.messages.map(toTurn) ?? []), ...pending]
  const isMine = (id?: string | null) =>
    !!id && !!me?.id && id.toUpperCase() === String(me.id).toUpperCase()
  const othersInThread =
    !!detail &&
    (detail.conversation.access !== 'owner' ||
      detail.shares.length > 0 ||
      detail.messages.some((m) => m.author && !isMine(m.author.id)))

  function openConversation(id: string | null) {
    setPending([])
    setEditing(null)
    setHistoryOpen(false)
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (id) next.set('conversation', id)
        else next.delete('conversation')
        return next
      },
      { replace: false }
    )
  }

  // ── Voice: dictation in, optional spoken replies out ──────────────────────
  const [listening, setListening] = useState(false)
  const [speakReplies, setSpeakReplies] = useState(false)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
  type SpeechRecognitionCtor = new () => {
    lang: string
    interimResults: boolean
    continuous: boolean
    onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void
    onend: () => void
    onerror: () => void
    start: () => void
    stop: () => void
  }
  const SpeechRec =
    typeof window !== 'undefined'
      ? (((window as unknown as Record<string, unknown>).SpeechRecognition as
          | SpeechRecognitionCtor
          | undefined) ??
        ((window as unknown as Record<string, unknown>).webkitSpeechRecognition as
          | SpeechRecognitionCtor
          | undefined))
      : undefined

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    if (!SpeechRec) {
      toast.message('Voice input is not supported in this browser')
      return
    }
    const rec = new SpeechRec()
    rec.lang = navigator.language || 'en-US'
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (e) => {
      const transcript = Array.from(
        { length: e.results.length },
        (_, i) => e.results[i][0].transcript
      ).join(' ')
      setInput(transcript)
    }
    rec.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }
    rec.onerror = () => setListening(false)
    recognitionRef.current = rec
    setListening(true)
    rec.start()
  }

  function speak(text: string) {
    if (!speakReplies || typeof window === 'undefined' || !('speechSynthesis' in window)) return
    // Strip markdown noise for the readback
    const plain = text
      .replace(/\|/g, ' ')
      .replace(/[#*`_>-]/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 600)
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(plain))
  }

  /** The stored thread caught up with what this tab just showed: drop the local copies. */
  async function settle(id: string) {
    await qc.fetchQuery({ queryKey: detailKey(id), queryFn: () => fetchDetail(id) }).catch(() => {})
    setPending([])
    void qc.invalidateQueries({ queryKey: ASK_LIST_KEY })
  }

  const send = useAiStream<ChatBody>(sharedClient, {
    subscribe: subscribeAi,
    connected: () => getSocket().connected,
    onDone: (data) => {
      setPending((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.reply,
          trace: data.trace,
          proposals: data.proposals,
          plans: data.plans,
          memorySuggestions: data.memory_suggestions,
          requestId: data.request_id ?? null,
          playbooksUsed: data.playbooks_used ?? 0,
          cachedAt: data.cached ? (data.cached_at ?? new Date().toISOString()) : null,
          stopped: data.stopped === true
        }
      ])
      freshRef.current = false
      if (data.remembered) void qc.invalidateQueries({ queryKey: ['nvr-profile-prefs'] })
      speak(data.reply)
      const id = data.conversation_id
      if (id) {
        if (id !== conversationIdRef.current) {
          conversationIdRef.current = id
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev)
              next.set('conversation', id)
              return next
            },
            { replace: true }
          )
        }
        void settle(id)
      }
    },
    onError: (message) => {
      toast.error(message || 'Chat request failed')
      setPending((prev) => prev.slice(0, -1)) // roll back the optimistic user turn
    }
  })
  // The stream's done handler outlives renders — it reads the id through a ref.
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  // "Ask again" bypasses the answer cache for the next send only (#723).
  const freshRef = useRef(false)
  function askAgain(question: string) {
    freshRef.current = true
    submit(question)
  }

  function submit(text?: string, opts: { conversationId?: string | null } = {}) {
    const content = (text ?? input).trim()
    if (!content || send.active) return
    const target = opts.conversationId !== undefined ? opts.conversationId : conversationId
    setPending((prev) => [...prev, { role: 'user', content, author: null, visible: true }])
    setInput('')
    // A stored thread sends only the new question — the server rebuilds the
    // history from the turns THIS person may read (#1809).
    void send.start(
      target
        ? {
            messages: [{ role: 'user', content }],
            conversation_id: target,
            fresh: freshRef.current
          }
        : { messages: [{ role: 'user', content }], save: true, fresh: freshRef.current }
    )
  }

  /** Edit an earlier question and continue as a branch (#1883); the original stays. */
  async function branchFrom(messageId: string, question: string) {
    if (!conversationId || !question.trim() || send.active) return
    try {
      const r = await api.post<{ data: { id: string } }>(
        `/ai/conversations/${conversationId}/branch`,
        { message_id: messageId, question }
      )
      const id = r.data.data.id
      setEditing(null)
      openConversation(id)
      conversationIdRef.current = id
      submit(question, { conversationId: id })
    } catch (err) {
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not branch'
      )
    }
  }

  async function togglePin() {
    if (!detail) return
    await api.patch(`/ai/conversations/${detail.conversation.id}`, {
      pinned: !detail.conversation.pinned
    })
    void qc.invalidateQueries({ queryKey: detailKey(detail.conversation.id) })
    void qc.invalidateQueries({ queryKey: ASK_LIST_KEY })
  }

  // Someone else asked or was answered in an open shared thread (#1809): the
  // event carries ids only — refetch, and the server filters each answer for us.
  useEffect(() => {
    const s = getSocket()
    const onEvent = (p: { conversation_id?: string; state?: string }) => {
      void qc.invalidateQueries({ queryKey: ASK_LIST_KEY })
      if (p.conversation_id && p.conversation_id === conversationIdRef.current) {
        void qc.invalidateQueries({ queryKey: detailKey(p.conversation_id) })
      }
    }
    s.on('ai:conversation', onEvent)
    return () => {
      s.off('ai:conversation', onEvent)
    }
  }, [qc])

  // `?q=` seeds and sends one question (the queue page's "Ask about this
  // queue", #1276), then leaves the URL — a reload must not re-ask it.
  const seededRef = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: consume the seeds once on mount
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    // A question handed over from inside the app (the queue page's "Ask about
    // this queue") rides sessionStorage and submits at once. A `?q=` in the
    // URL only fills the box — a link from outside must never fire a question
    // on the reader's behalf.
    let handed: string | null = null
    try {
      handed = sessionStorage.getItem(ASK_HANDOFF_KEY)
      if (handed) sessionStorage.removeItem(ASK_HANDOFF_KEY)
    } catch {
      handed = null
    }
    const q = searchParams.get('q')?.trim()
    if (q) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete('q')
          return next
        },
        { replace: true }
      )
    }
    if (handed?.trim()) submit(handed.trim(), { conversationId: null })
    else if (q) setInput(q)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new turns
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns.length, send.active, send.text, send.status])

  const notFound = !!conversationId && !!detailError

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Sparkles className='h-4 w-4 shrink-0 text-nvr-cyan' />
          <div className='min-w-0'>
            <h1 className='truncate text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              {detail?.conversation.title ?? 'Ask your data'}
            </h1>
            <p className='truncate text-[12px] text-muted-foreground'>
              {detail && detail.conversation.access !== 'owner'
                ? `${detail.conversation.owner.name}’s conversation — your questions run with your own access.`
                : 'Answers come from live queries, permission-checked as you. Read-only.'}
            </p>
          </div>
          <div className='ml-auto flex shrink-0 items-center gap-1'>
            <Button
              size='sm'
              variant='ghost'
              className='md:hidden'
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <History className='mr-1 h-3.5 w-3.5' /> History
            </Button>
            {detail && detail.conversation.access !== 'room' && (
              <Button size='sm' variant='ghost' onClick={() => void togglePin()} data-ask-pin>
                {detail.conversation.pinned ? (
                  <PinOff className='h-3.5 w-3.5' />
                ) : (
                  <Pin className='h-3.5 w-3.5' />
                )}
              </Button>
            )}
            {detail?.conversation.access === 'owner' && (
              <ShareMenu
                conversationId={detail.conversation.id}
                shares={detail.shares}
                detailKey={detailKey(detail.conversation.id)}
              />
            )}
            {detail?.conversation.access === 'owner' && (
              <PostToChatMenu
                conversationId={detail.conversation.id}
                detailKey={detailKey(detail.conversation.id)}
              />
            )}
            {(turns.length > 0 || conversationId) && (
              <Button size='sm' variant='ghost' onClick={() => openConversation(null)}>
                New chat
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside
          className={cn(
            'w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card',
            historyOpen ? 'flex' : 'hidden md:flex'
          )}
        >
          <AskHistory
            activeId={conversationId}
            onOpen={(id) => openConversation(id)}
            onDeleted={(id) => {
              if (id === conversationId) openConversation(null)
            }}
          />
        </aside>

        <div className='flex flex-1 min-w-0 flex-col'>
          <div
            ref={scrollRef}
            className='flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-background'
          >
            <div className='mx-auto w-full max-w-3xl space-y-4 p-6'>
              {detail && (detail.parent || detail.branches.length > 0) && (
                <div
                  className='flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-slate-400'
                  data-ask-branches
                >
                  <GitBranch className='h-3.5 w-3.5' />
                  {detail.parent && (
                    <>
                      Branch of
                      <button
                        type='button'
                        className='font-medium text-slate-700 underline decoration-dotted underline-offset-2 dark:text-slate-200'
                        onClick={() => openConversation(detail.parent?.id ?? null)}
                      >
                        {detail.parent.title}
                      </button>
                    </>
                  )}
                  {detail.branches.length > 0 && (
                    <>
                      {detail.parent ? ' · ' : ''}Branches:
                      {detail.branches.map((b, i) => (
                        <button
                          key={b.id}
                          type='button'
                          className='font-medium text-slate-700 underline decoration-dotted underline-offset-2 dark:text-slate-200'
                          onClick={() => openConversation(b.id)}
                        >
                          {i + 1} ({formatRelative(b.created_at)})
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}

              {notFound && (
                <div className='pt-16 text-center text-[13px] text-slate-500'>
                  This conversation is not available to you.
                </div>
              )}

              <MyWatchesPanel />

              {!notFound && turns.length === 0 && !conversationId && (
                <div className='pt-16 text-center'>
                  <Sparkles className='mx-auto h-8 w-8 text-slate-300' />
                  <p className='mt-3 text-[14px] font-medium text-slate-600 dark:text-slate-300'>
                    Ask anything about your data
                  </p>
                  <div className='mx-auto mt-4 flex max-w-md flex-col gap-2'>
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type='button'
                        onClick={() => submit(s)}
                        className='rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-[13px] text-slate-600 transition-colors hover:border-[#00ceff] dark:border-border dark:bg-card dark:text-slate-300'
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <p className='mt-4 text-[11.5px] text-slate-400'>
                    Say “remember that …” to keep a note for every answer.
                  </p>
                </div>
              )}

              {turns.map((t, i) => {
                const prevQuestion = turns
                  .slice(0, i)
                  .reverse()
                  .find((x) => x.role === 'user')?.content
                const otherAuthor = t.author && !isMine(t.author.id) ? t.author : null
                const exportable =
                  t.role === 'assistant' &&
                  !!t.id &&
                  !!conversationId &&
                  t.visible !== false &&
                  (t.trace ?? []).some(
                    (tr) => EXPORTABLE_TOOLS.has(tr.tool) && !tr.summary?.startsWith('error:')
                  )
                return (
                  <div
                    key={t.id ?? `pending-${i}`}
                    className={cn(
                      'group flex flex-col',
                      t.role === 'user' ? 'items-end' : 'items-start'
                    )}
                    data-ask-turn={t.role}
                  >
                    {othersInThread && t.role === 'user' && t.author && (
                      <span className='mb-0.5 text-[10.5px] text-slate-400'>
                        {isMine(t.author.id) ? 'You' : t.author.name}
                      </span>
                    )}
                    {t.role === 'user' && editing && t.id && editing.id === t.id ? (
                      <div className='w-full max-w-[85%] rounded-xl border border-slate-200 bg-white p-2 dark:border-border dark:bg-card'>
                        <textarea
                          value={editing.text}
                          onChange={(e) => setEditing({ id: editing.id, text: e.target.value })}
                          rows={2}
                          className='w-full resize-none rounded-md border border-slate-200 px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-[#00ceff] dark:border-border dark:bg-background'
                          data-ask-edit
                        />
                        <div className='mt-1.5 flex items-center justify-end gap-1.5'>
                          <span className='mr-auto text-[11px] text-slate-500'>
                            Continues as a branch — this thread stays as it is.
                          </span>
                          <Button size='sm' variant='ghost' onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                          <Button
                            size='sm'
                            disabled={!editing.text.trim() || send.active}
                            onClick={() => void branchFrom(editing.id, editing.text.trim())}
                          >
                            <GitBranch className='mr-1 h-3.5 w-3.5' /> Ask as a branch
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={cn(
                          'flex max-w-[85%] items-start gap-1',
                          t.role === 'user' ? 'flex-row-reverse' : ''
                        )}
                      >
                        <div
                          className={cn(
                            'min-w-0 rounded-xl px-4 py-2.5 text-[13.5px]',
                            t.role === 'user'
                              ? 'bg-nvr-navy text-white'
                              : 'border border-slate-200 bg-white text-slate-800 dark:border-border dark:bg-card dark:text-slate-200'
                          )}
                        >
                          {t.role === 'assistant' ? (
                            t.visible === false ? (
                              <div
                                className='flex items-start gap-2 text-[12.5px] text-slate-500 dark:text-slate-400'
                                data-ask-withheld
                              >
                                <Lock className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                                <span>
                                  Answered with {t.author?.name ?? 'someone else'}’s access, and it
                                  can’t be confirmed against yours, so it isn’t shown.{' '}
                                  {prevQuestion && (
                                    <button
                                      type='button'
                                      className='font-medium text-slate-700 underline decoration-dotted underline-offset-2 dark:text-slate-200'
                                      onClick={() => submit(prevQuestion)}
                                      disabled={send.active}
                                    >
                                      Ask it with my access
                                    </button>
                                  )}
                                </span>
                              </div>
                            ) : (
                              <>
                                {otherAuthor && (
                                  <div className='mb-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
                                    Answered with {otherAuthor.name}’s access — it matches what you
                                    can see.
                                  </div>
                                )}
                                {t.cachedAt && (
                                  <div
                                    className='mb-1.5 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400'
                                    data-ask-cached
                                  >
                                    <span>
                                      Answered {formatRelative(t.cachedAt)} — same question, same
                                      answer.
                                    </span>
                                    {prevQuestion && (
                                      <button
                                        type='button'
                                        className='underline decoration-dotted underline-offset-2 hover:text-slate-800 dark:hover:text-slate-200'
                                        onClick={() => askAgain(prevQuestion)}
                                        data-ask-again
                                      >
                                        Ask again
                                      </button>
                                    )}
                                  </div>
                                )}
                                {t.stopped && (
                                  <div
                                    className='mb-1.5 text-[11px] text-amber-700 dark:text-amber-400'
                                    data-ask-stopped
                                  >
                                    Stopped — this is what had arrived.
                                  </div>
                                )}
                                <AiMarkdown content={t.content} switchable />
                                {t.proposals?.map((p) => (
                                  <ProposalCard key={p.proposal_id} proposal={p} />
                                ))}
                                {t.plans?.map((p) => (
                                  <AiPlanCard key={p.plan_id} plan={p} subscribe={subscribePlan} />
                                ))}
                                <AiMemorySuggestions suggestions={t.memorySuggestions} />
                                {t.trace && t.trace.length > 0 && (
                                  <div className='mt-2 flex flex-wrap gap-1 border-t border-slate-100 pt-2 dark:border-border'>
                                    {t.trace.map((tr, ti) => (
                                      <span
                                        // biome-ignore lint/suspicious/noArrayIndexKey: static
                                        key={ti}
                                        title={JSON.stringify(tr.input)}
                                        className='inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 dark:bg-muted'
                                      >
                                        <Wrench className='h-2.5 w-2.5' />
                                        {tr.tool}: {tr.summary}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {(() => {
                                  const agg = watchableAggregate(t.trace)
                                  return agg ? <WatchThisNumber aggregate={agg} /> : null
                                })()}
                                <div className='mt-1.5 flex items-center justify-between gap-2'>
                                  <AiFeedbackButtons requestId={t.requestId} />
                                  <span className='flex items-center gap-2'>
                                    {exportable && conversationId && t.id && (
                                      <ExportButtons
                                        conversationId={conversationId}
                                        messageId={t.id}
                                      />
                                    )}
                                    {(t.playbooksUsed ?? 0) > 0 && (
                                      <span
                                        className='text-[10px] text-slate-400'
                                        data-ai-playbooks-used={t.playbooksUsed}
                                      >
                                        reused {t.playbooksUsed} past{' '}
                                        {t.playbooksUsed === 1 ? 'answer' : 'answers'}
                                      </span>
                                    )}
                                  </span>
                                </div>
                              </>
                            )
                          ) : (
                            <span className='whitespace-pre-wrap'>{t.content}</span>
                          )}
                        </div>
                        {t.role === 'user' && t.id && conversationId && !send.active && (
                          <button
                            type='button'
                            onClick={() => setEditing({ id: t.id as string, text: t.content })}
                            className='invisible mt-2 rounded p-1 text-slate-400 hover:text-slate-700 group-hover:visible dark:hover:text-slate-200'
                            data-tip='Edit and continue as a branch'
                            data-ask-branch
                          >
                            <Pencil className='h-3 w-3' />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              {send.active && (
                <div className='flex justify-start' data-ask-streaming>
                  <div className='max-w-[85%] rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13.5px] text-slate-800 dark:border-border dark:bg-card dark:text-slate-200'>
                    <AiStepList steps={send.steps} folded={!!send.text} />
                    {send.narration && (
                      <p
                        className='mb-1 text-[12px] italic text-slate-500 dark:text-slate-400'
                        data-ask-narration
                      >
                        {send.narration}
                      </p>
                    )}
                    {send.text ? (
                      <AiMarkdown content={send.text} />
                    ) : send.steps.some((st) => st.state === 'running') ? null : (
                      <div className='flex items-center gap-2 text-[13px] text-slate-400'>
                        <Loader2 className='h-3.5 w-3.5 animate-spin' />
                        {send.steps.length > 0
                          ? 'Putting the answer together…'
                          : (send.status ?? 'Querying your data…')}
                      </div>
                    )}
                    {send.text &&
                      send.status &&
                      send.steps.some((st) => st.state === 'running') && (
                        <div
                          className='mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400'
                          data-ask-status
                        >
                          <Loader2 className='h-3 w-3 animate-spin' /> {send.status}
                        </div>
                      )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className='shrink-0 border-t border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
            <div className='mx-auto flex w-full max-w-3xl items-end gap-2'>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
                rows={1}
                disabled={notFound}
                placeholder={
                  othersInThread
                    ? 'Ask a follow-up — it runs with your access'
                    : 'e.g. How many workflows are waiting on manager approval?'
                }
                className='max-h-32 flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[#00ceff] dark:border-border dark:bg-background'
              />
              <Button
                size='sm'
                variant={listening ? 'default' : 'outline'}
                onClick={toggleListening}
                title={listening ? 'Stop listening' : 'Dictate your question'}
                className={listening ? 'animate-pulse' : ''}
              >
                <Mic className='h-3.5 w-3.5' />
              </Button>
              <Button
                size='sm'
                variant='outline'
                onClick={() => {
                  setSpeakReplies((v) => {
                    if (v) window.speechSynthesis?.cancel()
                    return !v
                  })
                }}
                title={speakReplies ? 'Stop speaking replies' : 'Speak replies aloud'}
              >
                {speakReplies ? (
                  <Volume2 className='h-3.5 w-3.5 text-nvr-cyan' />
                ) : (
                  <VolumeX className='h-3.5 w-3.5' />
                )}
              </Button>
              {send.active && send.streamId ? (
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => void send.stop()}
                  data-tip='Stop the answer here'
                  data-ask-stop
                >
                  <Square className='h-3.5 w-3.5' />
                </Button>
              ) : (
                <Button
                  size='sm'
                  disabled={!input.trim() || send.active || notFound}
                  onClick={() => submit()}
                >
                  <Send className='h-3.5 w-3.5' />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Providers so friendly ids in answers link to /collections/:c/:id. */
export function AskPage() {
  const navigate = useNavigate()
  return (
    <NivaroProvider client={sharedClient}>
      <NavigationContext.Provider value={{ navigate: (p: string) => navigate(p) }}>
        <AskPageInner />
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
