import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Gauge, LayoutDashboard, ListChecks, Table2, X } from 'lucide-react'
import { Fragment, type ReactNode, useMemo } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, getDisplayTimezone } from '../../lib/utils'
import { type MessageToken, splitMessageTokens } from './chat-core'
import { useLinkPreview } from './chat-hooks'

/**
 * Chat message formatting (#929, #930, #941, #962).
 *
 * A small, safe markdown subset rendered as React elements — never HTML:
 * **bold**, *italic* / _italic_, ~~strike~~, `inline code`, fenced code
 * blocks, > quotes, bullet and numbered lists, pipe tables (a spreadsheet
 * range pasted into the composer becomes one), links, and time chips (times
 * the sender wrote, shown in the reader's own zone).
 */

export type TokenRenderer = (token: MessageToken, key: string) => ReactNode

interface Ctx {
  mine: boolean
  renderToken: TokenRenderer
  entityPattern: string
  timeRefs: Array<{ text: string; at: string }>
  navigate?: (url: string) => void
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?*_~]/gi
const CODE_RE = /`([^`\n]+)`/g
const EMPH_RE =
  /(\*\*[^*\n]+?\*\*|~~[^~\n]+?~~|(?<![\w*])\*(?!\s)[^*\n]+?(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)[^_\n]+?(?<!\s)_(?![\w_]))/g

/** Is this URL a link into this app? Returns the in-app path, or null. */
export function appPath(url: string): string | null {
  if (url.startsWith('/')) return url
  try {
    if (typeof window === 'undefined') return null
    const u = new URL(url)
    if (u.origin === window.location.origin) return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return null
  }
  return null
}

export function extractUrls(text: string): string[] {
  const out: string[] = []
  // Fenced code is not a link list.
  const stripped = text.replace(/```[\s\S]*?```/g, ' ').replace(CODE_RE, ' ')
  for (const m of stripped.matchAll(URL_RE)) if (!out.includes(m[0])) out.push(m[0])
  return out
}

function TimeChip({ text, at, mine }: { text: string; at: string; mine: boolean }) {
  const d = new Date(at)
  const zone = getDisplayTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  let shown = text
  let full = ''
  try {
    const now = new Date()
    const dayKey = (x: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'short' }).format(x)
    const tomorrow = new Date(now.getTime() + 86_400_000)
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit'
    }).format(d)
    const day =
      dayKey(d) === dayKey(now)
        ? 'today'
        : dayKey(d) === dayKey(tomorrow)
          ? 'tomorrow'
          : new Intl.DateTimeFormat('en-US', {
              timeZone: zone,
              weekday: 'short',
              month: 'short',
              day: 'numeric'
            }).format(d)
    shown = `${time} ${day}`
    full = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(d)
  } catch {
    /* keep the original text */
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 font-medium',
        mine ? 'bg-black/15' : 'bg-slate-200/70 text-slate-800 dark:bg-white/10 dark:text-slate-100'
      )}
      title={`“${text}” — ${full} (your time)`}
      data-chat-time-chip
    >
      <span aria-hidden>🕒</span>
      {shown}
    </span>
  )
}

/** Plain text leaf: time chips, then entity/mention tokens. */
function renderLeaf(text: string, ctx: Ctx, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const refs = ctx.timeRefs.filter((r) => r.text && text.includes(r.text))
  if (refs.length === 0) {
    splitMessageTokens(text, ctx.entityPattern).forEach((t, i) =>
      out.push(<Fragment key={`${key}.${i}`}>{ctx.renderToken(t, `${key}.${i}`)}</Fragment>)
    )
    return out
  }
  let rest = text
  let n = 0
  while (rest.length) {
    let best: { idx: number; ref: { text: string; at: string } } | null = null
    for (const r of refs) {
      const idx = rest.indexOf(r.text)
      if (idx >= 0 && (!best || idx < best.idx)) best = { idx, ref: r }
    }
    if (!best) {
      out.push(...renderLeaf(rest, { ...ctx, timeRefs: [] }, `${key}.t${n++}`))
      break
    }
    if (best.idx > 0)
      out.push(...renderLeaf(rest.slice(0, best.idx), { ...ctx, timeRefs: [] }, `${key}.t${n++}`))
    out.push(
      <TimeChip key={`${key}.c${n++}`} text={best.ref.text} at={best.ref.at} mine={ctx.mine} />
    )
    rest = rest.slice(best.idx + best.ref.text.length)
  }
  return out
}

function renderEmphasis(text: string, ctx: Ctx, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(EMPH_RE)) {
    const start = m.index ?? 0
    if (start > last) out.push(...renderLeaf(text.slice(last, start), ctx, `${key}.p${i}`))
    const tok = m[0]
    const k = `${key}.e${i++}`
    if (tok.startsWith('**'))
      out.push(<strong key={k}>{renderEmphasis(tok.slice(2, -2), ctx, k)}</strong>)
    else if (tok.startsWith('~~'))
      out.push(<s key={k}>{renderEmphasis(tok.slice(2, -2), ctx, k)}</s>)
    else out.push(<em key={k}>{renderEmphasis(tok.slice(1, -1), ctx, k)}</em>)
    last = start + tok.length
  }
  if (last < text.length) out.push(...renderLeaf(text.slice(last), ctx, `${key}.z`))
  return out
}

function renderLinks(text: string, ctx: Ctx, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    if (start > last) out.push(...renderEmphasis(text.slice(last, start), ctx, `${key}.u${i}`))
    const url = m[0]
    const inApp = appPath(url)
    const k = `${key}.l${i++}`
    out.push(
      <a
        key={k}
        href={url}
        target={inApp ? undefined : '_blank'}
        rel='noopener noreferrer'
        onClick={(e) => {
          if (inApp && ctx.navigate) {
            e.preventDefault()
            ctx.navigate(inApp)
          }
        }}
        className='break-all underline underline-offset-2 hover:opacity-80'
        data-chat-link
      >
        {url.replace(/^https?:\/\//, '').slice(0, 80)}
        {url.length > 90 ? '…' : ''}
      </a>
    )
    last = start + url.length
  }
  if (last < text.length) out.push(...renderEmphasis(text.slice(last), ctx, `${key}.y`))
  return out
}

function renderInline(text: string, ctx: Ctx, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(CODE_RE)) {
    const start = m.index ?? 0
    if (start > last) out.push(...renderLinks(text.slice(last, start), ctx, `${key}.s${i}`))
    out.push(
      <code
        key={`${key}.c${i++}`}
        className={cn(
          'rounded px-1 py-px font-mono text-[11.5px]',
          ctx.mine ? 'bg-black/20' : 'bg-slate-200/80 dark:bg-white/10'
        )}
      >
        {m[1]}
      </code>
    )
    last = start + m[0].length
  }
  if (last < text.length) out.push(...renderLinks(text.slice(last), ctx, `${key}.x`))
  return out
}

type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'code'; text: string }
  | { t: 'quote'; lines: string[] }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[]; start: number }
  | { t: 'table'; head: string[]; rows: string[][] }

const MAX_TABLE_ROWS = 25
const MAX_TABLE_COLS = 10

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ t: 'p', lines: para })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line.trim())) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i++])
      out.push({ t: 'code', text: body.join('\n') })
      continue
    }
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])
    ) {
      flush()
      const head = cells(line).slice(0, MAX_TABLE_COLS)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (rows.length < MAX_TABLE_ROWS) rows.push(cells(lines[i]).slice(0, MAX_TABLE_COLS))
        i++
      }
      i--
      out.push({ t: 'table', head, rows })
      continue
    }
    if (/^>\s?/.test(line)) {
      flush()
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''))
      i--
      out.push({ t: 'quote', lines: q })
      continue
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      flush()
      const items: string[] = []
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*•]\s+/, ''))
      i--
      out.push({ t: 'ul', items })
      continue
    }
    const num = line.match(/^\s*(\d{1,3})[.)]\s+/)
    if (num) {
      flush()
      const items: string[] = []
      while (i < lines.length && /^\s*\d{1,3}[.)]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*\d{1,3}[.)]\s+/, ''))
      i--
      out.push({ t: 'ol', items, start: Number(num[1]) })
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    para.push(line)
  }
  flush()
  return out
}

export function FormattedMessage({
  text,
  mine,
  renderToken,
  entityPattern,
  timeRefs,
  navigate
}: {
  text: string
  mine: boolean
  renderToken: TokenRenderer
  entityPattern: string
  timeRefs?: Array<{ text: string; at: string }>
  navigate?: (url: string) => void
}) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  const ctx: Ctx = { mine, renderToken, entityPattern, timeRefs: timeRefs ?? [], navigate }
  // One short paragraph renders as bare inline text (no extra block margin),
  // which keeps ordinary chat bubbles exactly as tight as before.
  if (blocks.length === 1 && blocks[0].t === 'p') {
    const b = blocks[0]
    return (
      <>
        {b.lines.map((l, i) => (
          <Fragment key={i}>
            {i > 0 && <br />}
            {renderInline(l, ctx, `l${i}`)}
          </Fragment>
        ))}
      </>
    )
  }
  return (
    <div className='space-y-1.5' data-chat-formatted>
      {blocks.map((b, bi) => {
        const k = `b${bi}`
        switch (b.t) {
          case 'p':
            return (
              <p key={k}>
                {b.lines.map((l, i) => (
                  <Fragment key={i}>
                    {i > 0 && <br />}
                    {renderInline(l, ctx, `${k}.${i}`)}
                  </Fragment>
                ))}
              </p>
            )
          case 'code':
            return (
              <pre
                key={k}
                className={cn(
                  'max-w-full overflow-x-auto whitespace-pre rounded-md px-2 py-1.5 font-mono text-[11.5px] leading-snug',
                  mine ? 'bg-black/20' : 'bg-slate-200/80 dark:bg-black/30'
                )}
              >
                {b.text}
              </pre>
            )
          case 'quote':
            return (
              <blockquote
                key={k}
                className={cn(
                  'border-l-2 pl-2',
                  mine
                    ? 'border-white/60'
                    : 'border-slate-300 text-slate-600 dark:border-slate-500 dark:text-slate-300'
                )}
              >
                {b.lines.map((l, i) => (
                  <Fragment key={i}>
                    {i > 0 && <br />}
                    {renderInline(l, ctx, `${k}.${i}`)}
                  </Fragment>
                ))}
              </blockquote>
            )
          case 'ul':
            return (
              <ul key={k} className='list-disc space-y-0.5 pl-4'>
                {b.items.map((it, i) => (
                  <li key={i}>{renderInline(it, ctx, `${k}.${i}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={k} start={b.start} className='list-decimal space-y-0.5 pl-5'>
                {b.items.map((it, i) => (
                  <li key={i}>{renderInline(it, ctx, `${k}.${i}`)}</li>
                ))}
              </ol>
            )
          case 'table':
            return (
              <div key={k} className='max-w-full overflow-x-auto' data-chat-table>
                <table className='border-collapse text-[11.5px] tabular-nums'>
                  <thead>
                    <tr>
                      {b.head.map((h, i) => (
                        <th
                          key={i}
                          className={cn(
                            'border px-1.5 py-0.5 text-left font-semibold',
                            mine ? 'border-white/30' : 'border-slate-300 dark:border-slate-600'
                          )}
                        >
                          {renderInline(h, ctx, `${k}.h${i}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {b.head.map((_, ci) => (
                          <td
                            key={ci}
                            className={cn(
                              'border px-1.5 py-0.5 align-top',
                              mine ? 'border-white/30' : 'border-slate-300 dark:border-slate-600'
                            )}
                          >
                            {renderInline(r[ci] ?? '', ctx, `${k}.${ri}.${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      })}
    </div>
  )
}

// ── Pasting a spreadsheet range (#941) ───────────────────────────────────────

/**
 * Tab-separated text from Excel or Sheets → a pipe table the formatter
 * renders. Null when the text is not a grid (needs ≥2 rows and ≥2 columns).
 */
export function tsvToTable(text: string): string | null {
  const rows = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  if (rows.length < 2 || !rows.every((r) => r.includes('\t'))) return null
  const grid = rows.slice(0, MAX_TABLE_ROWS + 1).map((r) =>
    r
      .split('\t')
      .slice(0, MAX_TABLE_COLS)
      .map((c) => c.replace(/\|/g, '/').trim())
  )
  const width = Math.max(...grid.map((r) => r.length))
  if (width < 2) return null
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
  const out = [line(grid[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`]
  for (const r of grid.slice(1)) out.push(line(r))
  if (rows.length > MAX_TABLE_ROWS + 1)
    out.push(`\n_…${rows.length - MAX_TABLE_ROWS - 1} more rows_`)
  return out.join('\n')
}

// ── Link previews (#930, #947) ───────────────────────────────────────────────

interface AppCardData {
  kind: 'record' | 'queue' | 'report' | 'dashboard' | 'view'
  id: string
  name?: string
  label?: string
  collection?: string
  collection_label?: string
  state?: { label: string; color: string | null } | null
  total?: number | null
  breached?: number | null
  widgets?: number
}

function AppLinkCard({ path, navigate }: { path: string; navigate?: (u: string) => void }) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-app-card', path],
    queryFn: () =>
      client
        .request<{ data: AppCardData | null }>(get('/chat/app-card', { path }))
        .then((r) => r.data ?? null),
    staleTime: 60_000,
    retry: false
  })
  if (!data) return null
  const Icon =
    data.kind === 'queue'
      ? ListChecks
      : data.kind === 'dashboard'
        ? LayoutDashboard
        : data.kind === 'report'
          ? Gauge
          : Table2
  const title = data.kind === 'record' ? (data.label ?? data.id) : (data.name ?? data.id)
  const kindLabel =
    data.kind === 'record'
      ? (data.collection_label ?? 'Record')
      : data.kind === 'view'
        ? 'Saved view'
        : data.kind.charAt(0).toUpperCase() + data.kind.slice(1)
  const facts: string[] = []
  if (data.total != null)
    facts.push(`${data.total.toLocaleString()} ${data.total === 1 ? 'item' : 'items'}`)
  if (data.breached) facts.push(`${data.breached} past SLA`)
  if (data.widgets != null)
    facts.push(`${data.widgets} ${data.widgets === 1 ? 'widget' : 'widgets'}`)
  return (
    <button
      type='button'
      onClick={() => navigate?.(path)}
      className='flex w-full max-w-[320px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left text-slate-700 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-200'
      data-chat-app-card={data.kind}
    >
      <Icon className='h-4 w-4 shrink-0 text-slate-400' />
      <span className='min-w-0 flex-1'>
        <span className='block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
          {kindLabel}
        </span>
        <span className='block truncate text-[12px] font-medium'>{title}</span>
        {facts.length > 0 && (
          <span className='block text-[11px] text-slate-500 dark:text-slate-400'>
            {facts.join(' · ')}
          </span>
        )}
      </span>
      {data.state && (
        <span
          className='shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold'
          style={{
            backgroundColor: data.state.color ? `${data.state.color}26` : 'rgba(100,116,139,.15)',
            color: data.state.color ?? undefined
          }}
        >
          {data.state.label}
        </span>
      )}
    </button>
  )
}

function ExternalLinkCard({ url }: { url: string }) {
  const p = useLinkPreview(url)
  if (!p?.ok) return null
  return (
    <a
      href={url}
      target='_blank'
      rel='noopener noreferrer'
      className='block w-full max-w-[320px] rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left hover:border-slate-300 dark:border-border dark:bg-card'
      data-chat-link-preview
    >
      <span className='flex items-center gap-1 text-[10.5px] text-slate-500 dark:text-slate-400'>
        <ExternalLink className='h-3 w-3' /> {p.site}
      </span>
      <span className='block truncate text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
        {p.title}
      </span>
      {p.description && (
        <span className='line-clamp-2 text-[11px] text-slate-600 dark:text-slate-300'>
          {p.description}
        </span>
      )}
    </a>
  )
}

export function LinkPreviews({
  text,
  navigate,
  onDismiss
}: {
  text: string
  navigate?: (url: string) => void
  /** The sender may remove the previews from their own message. */
  onDismiss?: () => void
}) {
  const urls = useMemo(() => extractUrls(text).slice(0, 3), [text])
  if (urls.length === 0) return null
  return (
    <div className='group/prev relative mt-1 space-y-1' data-chat-previews>
      {urls.map((u) => {
        const inApp = appPath(u)
        return inApp ? (
          <AppLinkCard key={u} path={inApp} navigate={navigate} />
        ) : (
          <ExternalLinkCard key={u} url={u} />
        )
      })}
      {onDismiss && (
        <button
          type='button'
          onClick={onDismiss}
          className='absolute -right-1.5 -top-1.5 hidden rounded-full border border-slate-200 bg-white p-0.5 text-slate-500 shadow-sm hover:text-slate-800 group-hover/prev:block dark:border-border dark:bg-card'
          title='Remove the preview (for everyone)'
          aria-label='Remove link preview'
          data-chat-preview-dismiss
        >
          <X className='h-3 w-3' />
        </button>
      )}
    </div>
  )
}
