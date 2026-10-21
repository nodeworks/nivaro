import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Smile, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useApiFetchConfig, useItemEditAuth, useNivaroClient } from '../../context'
import { del, get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { REACTION_EMOJI } from './chat-core'

/**
 * Custom emoji per workspace (#2459). The workspace's `:shortcode:` images are
 * served by `GET /chat/emoji/:id/image`; a reaction stores the literal
 * `:shortcode:` and message text keeps it as typed, so an emoji that was
 * deleted simply reads as its text again. The map lives in a small module
 * store so message rendering needs no query context.
 */

export interface CustomEmoji {
  id: number
  shortcode: string
  file: string
}

const SHORTCODE = /^:([a-z0-9][a-z0-9_+-]{1,39}):$/

let urls = new Map<string, string>()
const listeners = new Set<() => void>()
function setUrls(next: Map<string, string>): void {
  urls = next
  for (const l of listeners) l()
}
function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** shortcode → image URL, current for this tab. Empty until the list loads. */
export function useEmojiUrls(): Map<string, string> {
  return useSyncExternalStore(
    subscribe,
    () => urls,
    () => urls
  )
}

export function useCustomEmoji() {
  const client = useNivaroClient()
  const fetchCfg = useApiFetchConfig()
  const q = useQuery({
    queryKey: ['nvr-chat-emoji'],
    queryFn: () =>
      client.request<{ data: CustomEmoji[] }>(get('/chat/emoji')).then((r) => r.data ?? []),
    staleTime: 5 * 60_000
  })
  const list = q.data
  useEffect(() => {
    if (!list) return
    setUrls(
      new Map(
        list.map((e) => [e.shortcode, `${fetchCfg.apiBase}/chat/emoji/${e.id}/image?v=${e.file}`])
      )
    )
  }, [list, fetchCfg.apiBase])
  return { emoji: list ?? [], loading: q.isLoading, error: q.isError }
}

/** The image for `:code:`, or the text itself when the emoji is gone. */
export function EmojiGlyph({ value, size = 16 }: { value: string; size?: number }) {
  const map = useEmojiUrls()
  const m = SHORTCODE.exec(value)
  const src = m ? map.get(m[1]) : undefined
  if (!src) return <span>{value}</span>
  return (
    <img
      src={src}
      alt={value}
      data-tip={value}
      width={size}
      height={size}
      loading='lazy'
      draggable={false}
      className='inline-block align-text-bottom object-contain'
      style={{ width: size, height: size }}
      data-chat-custom-emoji={m?.[1]}
    />
  )
}

/** Swap known `:code:` runs in plain text for their images; unknown ones stay text. */
export function withCustomEmoji(text: string, map: Map<string, string>, key: string): ReactNode[] {
  if (map.size === 0 || !text.includes(':')) return [text]
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(/:([a-z0-9][a-z0-9_+-]{1,39}):/g)) {
    const src = map.get(m[1])
    if (!src) continue
    const start = m.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    out.push(
      <img
        key={`${key}.em${i++}`}
        src={src}
        alt={m[0]}
        data-tip={m[0]}
        loading='lazy'
        draggable={false}
        className='mx-px inline-block h-[1.25em] w-[1.25em] align-text-bottom object-contain'
        data-chat-custom-emoji={m[1]}
      />
    )
    last = start + m[0].length
  }
  if (last === 0) return [text]
  if (last < text.length) out.push(text.slice(last))
  return out
}

const COMMON = [
  ...REACTION_EMOJI,
  '🙌',
  '🙏',
  '🔥',
  '🚀',
  '💡',
  '👏',
  '😄',
  '😅',
  '🤔',
  '😮',
  '😢',
  '👎',
  '❌',
  '⚠️',
  '📌',
  '⏳'
]

const MAX_BYTES = 256 * 1024

/**
 * The emoji picker: a Common tab and a Workspace tab (the custom images, with
 * add and remove for admins). `onPick` gets a unicode character or `:code:`.
 */
export function EmojiPicker({
  onPick,
  children,
  align = 'start',
  onOpenChange
}: {
  onPick: (value: string) => void
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  /** A trigger inside a hover-revealed toolbar keeps the toolbar up while the picker is open. */
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpenState] = useState(false)
  const setOpen = (v: boolean) => {
    setOpenState(v)
    onOpenChange?.(v)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className='w-[264px] p-0' data-chat-emoji-picker>
        {open && (
          <PickerBody
            onPick={(v) => {
              onPick(v)
              setOpen(false)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function PickerBody({ onPick }: { onPick: (value: string) => void }) {
  const [tab, setTab] = useState<'common' | 'workspace'>('common')
  const { emoji, loading, error } = useCustomEmoji()
  const [q, setQ] = useState('')
  const tabBtn = (id: 'common' | 'workspace', label: string) => (
    <button
      type='button'
      role='tab'
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={cn(
        'h-7 flex-1 rounded-md text-[12px] font-medium transition-colors',
        tab === id
          ? 'bg-slate-100 text-slate-900 dark:bg-muted dark:text-slate-100'
          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
      )}
      data-chat-emoji-tab={id}
    >
      {label}
    </button>
  )
  return (
    <div>
      <div role='tablist' className='flex gap-1 border-b border-slate-200 p-1.5 dark:border-border'>
        {tabBtn('common', 'Common')}
        {tabBtn('workspace', emoji.length ? `Workspace · ${emoji.length}` : 'Workspace')}
      </div>
      {tab === 'common' ? (
        <div className='grid grid-cols-8 gap-0.5 p-2'>
          {COMMON.map((e) => (
            <button
              key={e}
              type='button'
              onClick={() => onPick(e)}
              className='flex h-7 w-7 items-center justify-center rounded-md text-[16px] hover:bg-slate-100 dark:hover:bg-muted'
              aria-label={e}
            >
              {e}
            </button>
          ))}
        </div>
      ) : (
        <WorkspaceTab
          emoji={emoji}
          loading={loading}
          error={error}
          q={q}
          setQ={setQ}
          onPick={onPick}
        />
      )}
    </div>
  )
}

function WorkspaceTab({
  emoji,
  loading,
  error,
  q,
  setQ,
  onPick
}: {
  emoji: CustomEmoji[]
  loading: boolean
  error: boolean
  q: string
  setQ: (v: string) => void
  onPick: (value: string) => void
}) {
  const { isAdmin } = useItemEditAuth()
  const fetchCfg = useApiFetchConfig()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  // Removing asks twice in place (the bin turns into "Remove?") — never a browser dialog.
  const [armed, setArmed] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const shown = useMemo(
    () => emoji.filter((e) => !q.trim() || e.shortcode.includes(q.trim().toLowerCase())),
    [emoji, q]
  )
  const refresh = () => void qc.invalidateQueries({ queryKey: ['nvr-chat-emoji'] })

  const upload = async (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_BYTES) {
      toast.error(`Emoji images are limited to ${MAX_BYTES / 1024} KB`)
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(
        `${fetchCfg.apiBase}/chat/emoji?shortcode=${encodeURIComponent(code)}`,
        {
          method: 'POST',
          headers: fetchCfg.authHeaders,
          credentials: fetchCfg.credentials,
          body: fd
        }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(body.error ?? 'Could not add that emoji')
        return
      }
      toast.success(`Added :${code}:`)
      setCode('')
      setAdding(false)
      refresh()
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div>
      <div className='relative px-2 pt-2'>
        <Search className='pointer-events-none absolute left-4 top-[17px] h-3.5 w-3.5 text-slate-400' />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Search workspace emoji'
          className='h-8 w-full rounded-md border border-slate-200 bg-white pl-7 pr-2 text-[12px] outline-none placeholder:text-slate-500 focus:border-nvr-cyan dark:border-border dark:bg-card'
          aria-label='Search workspace emoji'
        />
      </div>
      <div className='max-h-[200px] overflow-y-auto p-2' data-chat-emoji-grid>
        {loading ? (
          <div className='grid grid-cols-7 gap-1'>
            {Array.from({ length: 14 }, (_, i) => (
              <Skeleton key={i} className='h-8 w-8 rounded-md' />
            ))}
          </div>
        ) : error ? (
          <p className='px-1 py-3 text-center text-[12px] text-slate-500 dark:text-slate-400'>
            Workspace emoji could not be loaded.
          </p>
        ) : shown.length === 0 ? (
          <p className='px-1 py-3 text-center text-[12px] text-slate-500 dark:text-slate-400'>
            {emoji.length === 0
              ? isAdmin
                ? 'No workspace emoji yet. Add the first one below.'
                : 'No workspace emoji yet. Ask an admin to add some.'
              : 'Nothing matches that.'}
          </p>
        ) : (
          <div className='grid grid-cols-7 gap-1'>
            {shown.map((e) => (
              <div key={e.id} className='group/em relative'>
                <button
                  type='button'
                  onClick={() => onPick(`:${e.shortcode}:`)}
                  className='flex h-8 w-8 items-center justify-center rounded-md hover:bg-slate-100 dark:hover:bg-muted'
                  aria-label={`:${e.shortcode}:`}
                  data-tip={`:${e.shortcode}:`}
                >
                  <EmojiGlyph value={`:${e.shortcode}:`} size={22} />
                </button>
                {isAdmin && (
                  <button
                    type='button'
                    onClick={() => {
                      if (armed !== e.id) {
                        setArmed(e.id)
                        return
                      }
                      setArmed(null)
                      void client
                        .request(del(`/chat/emoji/${e.id}`))
                        .then(refresh)
                        .catch(() => toast.error('Could not remove that emoji'))
                    }}
                    onBlur={() => setArmed((a) => (a === e.id ? null : a))}
                    className={cn(
                      'absolute -right-0.5 -top-0.5 z-[1] flex h-4 items-center justify-center rounded-full ring-1 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                      armed === e.id
                        ? 'bg-red-600 px-1.5 text-[10px] font-medium text-white opacity-100 ring-red-600'
                        : 'w-4 bg-white text-slate-500 opacity-0 ring-slate-200 hover:text-red-600 group-hover/em:opacity-100 dark:bg-card dark:text-slate-400 dark:ring-border'
                    )}
                    aria-label={
                      armed === e.id
                        ? `Confirm: remove :${e.shortcode}: (it shows as text again)`
                        : `Remove :${e.shortcode}:`
                    }
                    data-tip={armed === e.id ? 'Click again — it shows as text again' : undefined}
                  >
                    {armed === e.id ? 'Remove?' : <Trash2 className='h-2.5 w-2.5' />}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {isAdmin && (
        <div className='border-t border-slate-200 p-2 dark:border-border'>
          {adding ? (
            <div className='flex items-center gap-1.5'>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9_+-]/g, ''))}
                placeholder='party_parrot'
                maxLength={40}
                className='h-7 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-[12px] outline-none placeholder:text-slate-500 focus:border-nvr-cyan dark:border-border dark:bg-card'
                aria-label='Emoji shortcode'
              />
              <input
                ref={fileRef}
                type='file'
                accept='image/png,image/gif,image/jpeg,image/webp'
                className='hidden'
                onChange={(e) => void upload(e.target.files?.[0])}
              />
              <button
                type='button'
                disabled={code.length < 2 || busy}
                onClick={() => fileRef.current?.click()}
                className='h-7 rounded-md bg-nvr-cyan px-2 text-[12px] font-medium text-white disabled:opacity-40'
              >
                {busy ? 'Adding…' : 'Choose image'}
              </button>
            </div>
          ) : (
            <button
              type='button'
              onClick={() => setAdding(true)}
              className='inline-flex items-center gap-1 text-[12px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
              data-chat-emoji-add
            >
              <Plus className='h-3.5 w-3.5' /> Add emoji
            </button>
          )}
          <p className='mt-1 text-[11px] text-slate-500 dark:text-slate-400'>
            PNG, GIF, JPEG or WebP, up to {MAX_BYTES / 1024} KB.
          </p>
        </div>
      )}
    </div>
  )
}

/** The little smiley button used beside the composer tools and reaction bar. */
export function EmojiButton({
  onPick,
  className,
  label = 'Emoji',
  onOpenChange
}: {
  onPick: (value: string) => void
  className?: string
  label?: string
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <EmojiPicker onPick={onPick} onOpenChange={onOpenChange}>
      <button
        type='button'
        className={cn(
          'rounded-full p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200',
          className
        )}
        aria-label={label}
        data-tip={label}
        data-chat-emoji-button
      >
        <Smile className='h-3 w-3' />
      </button>
    </EmojiPicker>
  )
}
