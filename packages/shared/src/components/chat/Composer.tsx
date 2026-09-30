import { useQuery } from '@tanstack/react-query'
import { AlarmClock, AlertTriangle, Hash, Paperclip, Quote, Send, Type, X } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useApiFetchConfig, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  type ChatMessage,
  type ChatOnlineUser,
  dmPeer,
  getMentionQuery,
  useChatBotName,
  useChatConfig,
  useChatRooms,
  useSendChatMessage,
  useTypingIndicator,
  useUserSearch
} from './chat-core'
import { useRoomInfo, useScheduledMessages } from './chat-hooks'
import { tsvToTable } from './MessageFormat'

/**
 * The chat composer, shared by a room and a thread pane.
 *
 * Multi-line (Shift+Enter for a new line), @ mentions ranked room members →
 * people you talk to → everyone (#982), `#` to insert a record (#934), a
 * pasted spreadsheet range becomes a table (#941), Ctrl/⌘+B / I / E format
 * the selection (#929), attachments upload with progress and can be cancelled
 * (#964), quote reply (#928), urgent (#932) and send-later (#939). Sending
 * goes through the outbox, so a dropped connection never loses the message.
 */

export interface ComposerHandle {
  addFiles: (files: File[]) => void
  focus: () => void
}

interface PendingFile {
  key: string
  name: string
  type: string | null
  progress: number
  id: string | null
  xhr: XMLHttpRequest | null
  error: string | null
}

interface Candidate {
  user_id: string
  display_name: string | null
  sub?: string | null
  kind: 'person' | 'bot' | 'here' | 'channel'
}

interface RecordHit {
  token: string
  label: string
  type: string
}

const FORMAT_KEYS: Record<string, [string, string]> = {
  b: ['**', '**'],
  i: ['_', '_'],
  e: ['`', '`']
}

function recordQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor)
  const m = before.match(/(?:^|\s)#([A-Za-z0-9-]{1,30})$/)
  return m ? m[1] : null
}

export const ChatComposer = forwardRef<
  ComposerHandle,
  {
    room: string
    label: string
    parentId?: number | null
    quote?: ChatMessage | null
    onClearQuote?: () => void
    onSent?: (text: string) => void
    /** Posting is closed here (announcement channel) — says why. */
    disabledReason?: string | null
    compact?: boolean
    th: { input: string; divider: string; surface: string; accentSoft: string; action: string }
    renderAvatar: (id: string, name: string | null) => React.ReactNode
  }
>(function ChatComposer(
  {
    room,
    label,
    parentId = null,
    quote,
    onClearQuote,
    onSent,
    disabledReason,
    compact,
    th,
    renderAvatar
  },
  ref
) {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const fetchCfg = useApiFetchConfig()
  const me = cfg.me
  const send = useSendChatMessage(room)
  const typing = useTypingIndicator(room)
  const botName = useChatBotName()
  const { rooms } = useChatRooms()
  const info = useRoomInfo(room)
  const { create: schedule } = useScheduledMessages(false)
  const [draft, setDraft] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [recordQ, setRecordQ] = useState<string | null>(null)
  const [pickIndex, setPickIndex] = useState(0)
  const [files, setFiles] = useState<PendingFile[]>([])
  const [pastedTable, setPastedTable] = useState<{ raw: string; table: string } | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleAt, setScheduleAt] = useState('')
  const mentionMapRef = useRef(new Map<string, string>())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isChannel = room.startsWith('ch:') && !room.startsWith('ch:grp-')

  useImperativeHandle(ref, () => ({
    addFiles: (f: File[]) => startUploads(f),
    focus: () => inputRef.current?.focus()
  }))

  // Autosize: grow with the text up to eight lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure per draft
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 8 * 19 + 16)}px`
  }, [draft])

  useEffect(() => {
    if (quote) inputRef.current?.focus()
  }, [quote])

  // ── Mentions (#982): room members, then people you DM, then everyone ─────
  const dmPeers = useMemo(() => {
    const out: Array<{ id: string; name: string }> = []
    if (!me) return out
    for (const r of rooms) {
      if (r.kind !== 'dm') continue
      const p = dmPeer(r.room, me.id)
      if (p) out.push({ id: p, name: r.label })
    }
    return out
  }, [rooms, me])
  const { users: searched } = useUserSearch(mentionQuery ?? '', (mentionQuery?.length ?? 0) >= 2)
  const mentionCandidates = useMemo((): Candidate[] => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    const matches = (name: string | null | undefined) =>
      !!name &&
      name
        .toLowerCase()
        .split(/\s+/)
        .some((w) => w.startsWith(q))
    const seen = new Set<string>([String(me?.id ?? '').toUpperCase()])
    const out: Candidate[] = []
    const push = (c: Candidate) => {
      const k = c.user_id.toUpperCase()
      if (seen.has(k)) return
      seen.add(k)
      out.push(c)
    }
    if (isChannel) {
      if ('here'.startsWith(q))
        out.push({
          user_id: '__here__',
          display_name: 'here',
          sub: 'Everyone online in this room',
          kind: 'here'
        })
      if ('channel'.startsWith(q))
        out.push({
          user_id: '__channel__',
          display_name: 'channel',
          sub: 'Every member of this room',
          kind: 'channel'
        })
    }
    if (botName && botName.toLowerCase().startsWith(q))
      out.push({ user_id: '__bot__', display_name: botName, sub: 'AI assistant', kind: 'bot' })
    for (const m of info?.members ?? [])
      if (matches(m.name))
        push({ user_id: m.id, display_name: m.name, sub: 'In this room', kind: 'person' })
    for (const p of dmPeers)
      if (matches(p.name))
        push({ user_id: p.id, display_name: p.name, sub: 'You message them', kind: 'person' })
    for (const u of cfg.onlineUsers as ChatOnlineUser[])
      if (matches(u.display_name))
        push({ user_id: u.user_id, display_name: u.display_name, sub: 'Online', kind: 'person' })
    for (const u of searched) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
      if (matches(name) || (u.email ?? '').toLowerCase().startsWith(q))
        push({ user_id: u.id, display_name: name, sub: null, kind: 'person' })
    }
    return out.slice(0, 8)
  }, [mentionQuery, info, dmPeers, cfg.onlineUsers, searched, botName, isChannel, me])

  // ── # record picker (#934) ────────────────────────────────────────────────
  const { data: roomTypes } = useQuery({
    queryKey: ['nvr-chat-room-types'],
    queryFn: () =>
      client
        .request<{
          data: Array<{
            prefix: string
            collection: string
            match_field: string
            is_active: boolean
            label: string | null
          }>
        }>(get('/chat/room-types'))
        .then((r) => (r.data ?? []).filter((t) => t.is_active)),
    staleTime: 5 * 60_000
  })
  const { data: recordHits = [] } = useQuery({
    queryKey: ['nvr-chat-record-pick', recordQ],
    queryFn: async () => {
      const out: RecordHit[] = []
      for (const t of roomTypes ?? []) {
        try {
          const res = await client.request<{ data: Array<Record<string, unknown>> }>(
            get(`/items/${t.collection}`, {
              limit: 5,
              fields: `id,${t.match_field}`,
              filter: JSON.stringify({ [t.match_field]: { _contains: recordQ } }),
              sort: `-id`
            })
          )
          for (const r of res.data ?? []) {
            const token = String(r[t.match_field] ?? r.id ?? '')
            if (token)
              out.push({ token, label: token, type: t.label ?? t.collection.replace(/_/g, ' ') })
          }
        } catch {
          /* a type the person cannot read contributes nothing */
        }
      }
      return out.slice(0, 8)
    },
    enabled: !!recordQ && recordQ.length >= 2 && (roomTypes?.length ?? 0) > 0,
    staleTime: 30_000
  })

  const pickerOpen =
    (mentionQuery !== null && mentionCandidates.length > 0) ||
    (recordQ !== null && recordHits.length > 0)

  const replaceBeforeCursor = (pattern: RegExp, insert: string) => {
    const el = inputRef.current
    const cursor = el?.selectionStart ?? draft.length
    const before = draft.slice(0, cursor).replace(pattern, insert)
    const next = before + draft.slice(cursor)
    setDraft(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(before.length, before.length)
    })
  }

  const selectMention = (c: Candidate) => {
    if (c.kind === 'here' || c.kind === 'channel') {
      replaceBeforeCursor(/@([^@\n\r]*)$/, `@${c.display_name} `)
    } else {
      const name = c.display_name ?? 'Unknown'
      replaceBeforeCursor(/@([^@\n\r]*)$/, `@[${name}] `)
      if (c.kind === 'person') mentionMapRef.current.set(name, c.user_id)
    }
    setMentionQuery(null)
  }

  const selectRecord = (h: RecordHit) => {
    replaceBeforeCursor(/#([A-Za-z0-9-]{1,30})$/, `${h.token} `)
    setRecordQ(null)
  }

  // ── Attachments with progress (#964) ──────────────────────────────────────
  const startUploads = (list: File[]) => {
    for (const f of list.slice(0, 10)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const xhr = new XMLHttpRequest()
      const entry: PendingFile = {
        key,
        name: f.name,
        type: f.type || null,
        progress: 0,
        id: null,
        xhr,
        error: null
      }
      setFiles((prev) => [...prev, entry])
      const update = (patch: Partial<PendingFile>) =>
        setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)))
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) update({ progress: e.loaded / e.total })
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const id = (JSON.parse(xhr.responseText) as { data: { id: string } }).data.id
            update({ id, progress: 1, xhr: null })
          } catch {
            update({ error: 'Upload failed', xhr: null })
          }
        } else {
          let msg = 'Upload failed'
          try {
            msg = (JSON.parse(xhr.responseText) as { error?: string }).error ?? msg
          } catch {
            /* keep the generic message */
          }
          update({ error: msg, xhr: null })
        }
      }
      xhr.onerror = () => update({ error: 'Upload failed', xhr: null })
      xhr.open('POST', `${fetchCfg.apiBase}/files/upload`)
      for (const [k, v] of Object.entries(fetchCfg.authHeaders)) xhr.setRequestHeader(k, v)
      xhr.withCredentials = fetchCfg.credentials === 'include'
      const fd = new FormData()
      fd.append('file', f)
      xhr.send(fd)
    }
  }
  const cancelFile = (key: string) =>
    setFiles((prev) => {
      prev.find((p) => p.key === key)?.xhr?.abort()
      return prev.filter((p) => p.key !== key)
    })
  const uploading = files.some((f) => !f.id && !f.error)

  // ── Send ──────────────────────────────────────────────────────────────────
  const collect = () => {
    const text = draft.trim()
    const attachments = files.filter((f) => f.id).map((f) => f.id as string)
    const mentions = [...mentionMapRef.current.entries()]
      .filter(([name]) => text.includes(`@[${name}]`))
      .map(([, id]) => id)
    return { text, attachments, mentions }
  }
  const reset = () => {
    setDraft('')
    setFiles([])
    setUrgent(false)
    setMentionQuery(null)
    setRecordQ(null)
    setPastedTable(null)
    mentionMapRef.current.clear()
    onClearQuote?.()
    typing.clearTyping()
  }
  const submit = () => {
    if (disabledReason || uploading) return
    const { text, attachments, mentions } = collect()
    if (!text && attachments.length === 0) return
    send.mutate({ text, mentions, attachments, parentId, quoteId: quote?.id ?? null, urgent })
    reset()
    onSent?.(text)
  }
  const doSchedule = (when: Date) => {
    const { text, attachments } = collect()
    if (!text && attachments.length === 0) {
      toast.error('Write the message first')
      return
    }
    schedule.mutate(
      { room, message: text, attachments, parent_id: parentId, send_at: when.toISOString() },
      {
        onSuccess: () => {
          toast.success(
            `Scheduled for ${when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
            { description: 'Find it under Scheduled in the chat panel.' }
          )
          reset()
          setScheduleOpen(false)
        },
        onError: (e) =>
          toast.error(
            (e as { response?: { error?: string } })?.response?.error ?? 'Could not schedule it'
          )
      }
    )
  }
  const presets = useMemo(() => {
    const now = new Date()
    const inHour = new Date(now.getTime() + 60 * 60_000)
    const tomorrow9 = new Date(now)
    tomorrow9.setDate(now.getDate() + 1)
    tomorrow9.setHours(9, 0, 0, 0)
    const monday9 = new Date(now)
    monday9.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7))
    monday9.setHours(9, 0, 0, 0)
    return [
      { label: 'In 1 hour', at: inHour },
      { label: 'Tomorrow 9:00 AM', at: tomorrow9 },
      { label: 'Monday 9:00 AM', at: monday9 }
    ]
  }, [scheduleOpen])

  const onChange = (value: string, cursor: number) => {
    setDraft(value)
    typing.onType()
    const mq = getMentionQuery(value, cursor)
    setMentionQuery(mq)
    const rq = mq === null ? recordQuery(value, cursor) : null
    setRecordQ(rq)
    if (mq !== null || rq !== null) setPickIndex(0)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      const n = mentionQuery !== null ? mentionCandidates.length : recordHits.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPickIndex((i) => (i + 1) % n)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPickIndex((i) => (i - 1 + n) % n)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (mentionQuery !== null) selectMention(mentionCandidates[pickIndex])
        else selectRecord(recordHits[pickIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
        setRecordQ(null)
        return
      }
    }
    if ((e.metaKey || e.ctrlKey) && FORMAT_KEYS[e.key.toLowerCase()]) {
      e.preventDefault()
      const [open, close] = FORMAT_KEYS[e.key.toLowerCase()]
      const el = e.currentTarget
      const a = el.selectionStart
      const b = el.selectionEnd
      const next = draft.slice(0, a) + open + draft.slice(a, b) + close + draft.slice(b)
      setDraft(next)
      requestAnimationFrame(() => el.setSelectionRange(a + open.length, b + open.length))
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
    if (e.key === 'Escape' && quote) onClearQuote?.()
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files]
    if (pasted.length > 0) {
      e.preventDefault()
      startUploads(pasted)
      return
    }
    const text = e.clipboardData.getData('text/plain')
    const table = text ? tsvToTable(text) : null
    if (table) {
      e.preventDefault()
      const el = e.currentTarget
      const a = el.selectionStart
      const b = el.selectionEnd
      const prefix = draft.slice(0, a)
      const insert = `${prefix && !prefix.endsWith('\n') ? '\n' : ''}${table}\n`
      setDraft(prefix + insert + draft.slice(b))
      setPastedTable({ raw: text, table: insert })
    }
  }

  const undoTable = () => {
    if (!pastedTable) return
    setDraft((d) => d.replace(pastedTable.table, pastedTable.raw))
    setPastedTable(null)
  }

  if (disabledReason) {
    return (
      <div
        className={cn(
          'shrink-0 border-t px-3 py-2.5 text-center text-[11.5px] text-slate-500 dark:text-slate-400',
          th.divider
        )}
        data-chat-composer-closed
      >
        {disabledReason}
      </div>
    )
  }

  return (
    <div className={cn('shrink-0 border-t', th.divider)} data-chat-composer-wrap>
      {quote && (
        <div className='flex items-start gap-2 px-3 pt-2' data-chat-quote-draft>
          <Quote className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
          <div className='min-w-0 flex-1 text-[11.5px]'>
            <span className='font-semibold text-slate-600 dark:text-slate-300'>
              Quoting {quote.sender_name ?? 'a message'}
            </span>
            <p className='truncate text-slate-500 dark:text-slate-400'>
              {quote.deleted_at ? 'Message removed' : quote.message || 'Attachment'}
            </p>
          </div>
          <button
            type='button'
            onClick={onClearQuote}
            className='rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-100'
            aria-label='Stop quoting'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className='flex flex-wrap items-center gap-1.5 px-3 pt-2'>
          {files.map((f) => (
            <span
              key={f.key}
              className={cn(
                'relative inline-flex max-w-[200px] items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[11px]',
                f.error
                  ? 'border-red-300 text-red-700 dark:border-red-500/50 dark:text-red-300'
                  : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'
              )}
              title={f.error ?? f.name}
              data-chat-upload={f.id ? 'done' : f.error ? 'failed' : 'uploading'}
            >
              {!f.id && !f.error && (
                <span
                  className='absolute inset-y-0 left-0 bg-[#00ceff26] transition-[width]'
                  style={{ width: `${Math.round(f.progress * 100)}%` }}
                  aria-hidden
                />
              )}
              <Paperclip className='relative h-3 w-3 shrink-0 opacity-60' />
              <span className='relative truncate'>
                {f.error ? `${f.name} — ${f.error}` : f.name}
              </span>
              {!f.id && !f.error && (
                <span className='relative tabular-nums text-slate-500'>
                  {Math.round(f.progress * 100)}%
                </span>
              )}
              <button
                type='button'
                onClick={() => cancelFile(f.key)}
                className='relative text-slate-400 hover:text-red-500'
                aria-label={f.id || f.error ? `Remove ${f.name}` : `Cancel ${f.name}`}
                title={f.id || f.error ? 'Remove' : 'Cancel upload'}
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          ))}
        </div>
      )}
      {pastedTable && (
        <p
          className='px-3 pt-1.5 text-[11px] text-slate-500 dark:text-slate-400'
          data-chat-pasted-table
        >
          Pasted as a table.{' '}
          <button
            type='button'
            onClick={undoTable}
            className='font-medium underline underline-offset-2'
          >
            Paste as plain text instead
          </button>
        </p>
      )}
      <form
        className={cn('relative', compact ? 'p-2' : 'p-2.5')}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        data-chat-composer
      >
        {pickerOpen && (
          <div
            className={cn(
              'absolute bottom-full left-2.5 z-20 mb-1 w-[300px] overflow-hidden rounded-xl border shadow-lg',
              th.surface,
              'border-slate-200 dark:border-border'
            )}
            data-chat-picker={mentionQuery !== null ? 'mention' : 'record'}
          >
            {mentionQuery !== null
              ? mentionCandidates.map((c, i) => (
                  <button
                    key={c.user_id}
                    type='button'
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectMention(c)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]',
                      i === pickIndex ? th.accentSoft : 'text-slate-700 dark:text-slate-200'
                    )}
                  >
                    {c.kind === 'person' || c.kind === 'bot' ? (
                      renderAvatar(c.user_id, c.display_name)
                    ) : (
                      <span className='flex h-[22px] w-[22px] items-center justify-center rounded-full bg-slate-200 text-[11px] font-bold text-slate-600 dark:bg-muted dark:text-slate-300'>
                        @
                      </span>
                    )}
                    <span className='min-w-0 flex-1 truncate'>
                      {c.kind === 'here' || c.kind === 'channel'
                        ? `@${c.display_name}`
                        : c.display_name}
                      {c.sub && (
                        <span className='ml-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
                          {c.sub}
                        </span>
                      )}
                    </span>
                  </button>
                ))
              : recordHits.map((h, i) => (
                  <button
                    key={`${h.type}:${h.token}`}
                    type='button'
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectRecord(h)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]',
                      i === pickIndex ? th.accentSoft : 'text-slate-700 dark:text-slate-200'
                    )}
                  >
                    <Hash className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                    <span className='min-w-0 flex-1 truncate font-medium'>{h.label}</span>
                    <span className='shrink-0 text-[10.5px] capitalize text-slate-500 dark:text-slate-400'>
                      {h.type}
                    </span>
                  </button>
                ))}
          </div>
        )}
        {/* One box: the text gets the whole width, the tools sit under it. In a
            400px panel a single row left the field half-width and the
            placeholder wrapped onto three lines. */}
        <div
          className={cn(
            'rounded-lg border transition-colors focus-within:border-nvr-cyan',
            th.input,
            urgent && 'border-red-400 focus-within:border-red-500 dark:border-red-500'
          )}
          data-chat-composer-box
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) =>
              onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={parentId ? 'Reply in thread…' : `Message ${label}…`}
            className='block min-h-9 w-full resize-none bg-transparent px-3 pb-1 pt-2 text-[12.5px] leading-[19px] outline-none placeholder:text-slate-500 dark:placeholder:text-slate-400'
            aria-label={parentId ? 'Reply in thread' : `Message ${label}`}
            data-chat-input
          />
          <div className='flex items-center gap-0.5 px-1 pb-1' data-chat-composer-tools>
            <input
              ref={fileInputRef}
              type='file'
              multiple
              className='hidden'
              onChange={(e) => {
                startUploads([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
            <FormattingHint botName={botName} />
            <button
              type='button'
              onClick={() => fileInputRef.current?.click()}
              className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
              aria-label='Attach a file'
              title='Attach a file (or paste / drop one)'
            >
              <Paperclip className='h-4 w-4' strokeWidth={2} />
            </button>
            <button
              type='button'
              onClick={() => setUrgent((u) => !u)}
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
                urgent
                  ? 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300'
                  : 'text-slate-500 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
              )}
              aria-pressed={urgent}
              aria-label='Mark urgent'
              title={
                urgent
                  ? 'Urgent: reaches people even when they muted the room (5 per hour)'
                  : 'Mark urgent — breaks through mute for the people it is addressed to'
              }
              data-chat-urgent-toggle={urgent ? 'on' : 'off'}
            >
              <AlertTriangle className='h-4 w-4' strokeWidth={2} />
            </button>
            <Popover open={scheduleOpen} onOpenChange={setScheduleOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
                  aria-label='Send later'
                  title='Send later'
                  data-chat-schedule
                >
                  <AlarmClock className='h-4 w-4' strokeWidth={2} />
                </button>
              </PopoverTrigger>
              <PopoverContent align='end' side='top' className='w-[240px] p-2'>
                <p className='px-1 pb-1.5 text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
                  Send this later
                </p>
                {presets.map((p) => (
                  <button
                    key={p.label}
                    type='button'
                    onClick={() => doSchedule(p.at)}
                    className='flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
                  >
                    {p.label}
                  </button>
                ))}
                <div className='mt-1.5 flex items-center gap-1 border-t border-slate-100 pt-2 dark:border-border'>
                  <input
                    type='datetime-local'
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    className={cn(
                      'h-8 min-w-0 flex-1 rounded-md border px-1.5 text-[11.5px] outline-none',
                      th.input
                    )}
                    aria-label='Send at'
                  />
                  <button
                    type='button'
                    disabled={!scheduleAt}
                    onClick={() => doSchedule(new Date(scheduleAt))}
                    className={cn(
                      'h-8 rounded-md px-2 text-[11.5px] font-medium disabled:opacity-40',
                      th.action
                    )}
                  >
                    Set
                  </button>
                </div>
              </PopoverContent>
            </Popover>
            <button
              type='submit'
              disabled={(!draft.trim() && !files.some((f) => f.id)) || uploading}
              className={cn(
                'ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-[filter] hover:brightness-110 disabled:opacity-40',
                urgent ? 'bg-red-600 text-white' : th.action
              )}
              aria-label={urgent ? 'Send urgent' : 'Send'}
              title={uploading ? 'Waiting for the upload to finish' : undefined}
              data-chat-send
            >
              <Send className='h-4 w-4' strokeWidth={2} />
            </button>
          </div>
        </div>
      </form>
    </div>
  )
})

function FormattingHint({ botName }: { botName?: string | null }) {
  const rows: Array<[string, string]> = [
    ['@name', 'Mention someone'],
    ...(botName ? ([[`@${botName}`, 'Ask the assistant']] as Array<[string, string]>) : []),
    ['**bold**', 'Bold (Ctrl/⌘ B)'],
    ['_italic_', 'Italic (Ctrl/⌘ I)'],
    ['`code`', 'Code (Ctrl/⌘ E)'],
    ['~~strike~~', 'Strikethrough'],
    ['```', 'Code block (on its own line)'],
    ['> quote', 'Quote'],
    ['- item', 'Bulleted list'],
    ['1. item', 'Numbered list'],
    ['#AB26', 'Link a record'],
    ['Shift + Enter', 'New line']
  ]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
          aria-label='Formatting and shortcuts'
          title='Formatting, @mentions and # records'
          data-chat-format-hint
        >
          <Type className='h-4 w-4' strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' side='top' className='w-[260px] p-3'>
        <p className='pb-2 text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
          Writing a message
        </p>
        <dl className='grid grid-cols-[96px_1fr] gap-x-2 gap-y-1 text-[11.5px]'>
          {rows.map(([k, v]) => (
            <div key={k} className='contents'>
              <dt>
                <code className='rounded bg-slate-100 px-1 text-[11px] dark:bg-muted'>{k}</code>
              </dt>
              <dd className='text-slate-600 dark:text-slate-300'>{v}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}
