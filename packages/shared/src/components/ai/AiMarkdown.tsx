import { type ReactNode, useCallback, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { useNavigation, useOptionalNivaroClient } from '../../context'
import { cn } from '../../lib/utils'
import { AutolinkedText } from '../AutolinkedText'

/**
 * Renders an assistant reply's markdown: headings, paragraphs, bullet and
 * numbered lists, fenced code, inline bold/italic/code/links, and pipe
 * tables. Tables are the part that matters — a model answering a record
 * question loves a 4-column table with 80-character names, which reads as
 * a wall of pipes on a phone. Below the `sm` breakpoint every table row
 * becomes a small card (first cell as its title, the rest as label/value
 * lines); wider screens keep the table inside a horizontal scroller.
 *
 * Also repairs a table the model emitted on ONE line ("| a | b | |---|---| |
 * x | y |") — the pipe-separated rows are split back apart before parsing.
 */

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'chart'; spec: ChartSpec }

/** A chart the model attached (#724): a fenced ```chart block holding JSON. */
export type ChartSpec = {
  type: 'bar' | 'line' | 'pie'
  title?: string
  data: Array<{ label: string; value: number }>
}

export function parseChartSpec(text: string): ChartSpec | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const type = raw.type === 'line' || raw.type === 'pie' ? raw.type : 'bar'
    const data = Array.isArray(raw.data)
      ? (raw.data as Array<Record<string, unknown>>)
          .map((d) => ({ label: String(d?.label ?? ''), value: Number(d?.value) }))
          .filter((d) => d.label && Number.isFinite(d.value))
          .slice(0, 40)
      : []
    if (data.length < 2) return null
    return { type, title: typeof raw.title === 'string' ? raw.title : undefined, data }
  } catch {
    return null
  }
}

const SEPARATOR_ROW = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

/** A whole table on one line: rows are separated by "| |" — cut there. */
function unflattenTables(src: string): string {
  return src
    .split('\n')
    .flatMap((line) => {
      const t = line.trim()
      if (!t.startsWith('|') || (!/\|\s*\|\s*[:-]{2,}/.test(t) && !/\|\s+\|\s*\S/.test(t)))
        return [line]
      if ((t.match(/\|\s+\|/g) ?? []).length < 1) return [line]
      return t
        .split(/\|\s+(?=\|)/)
        .map((r) => (r.trim().endsWith('|') ? r.trim() : `${r.trim()} |`))
    })
    .join('\n')
}

export function parseAiMarkdown(src: string): Block[] {
  const lines = unflattenTables(src.replace(/\r\n/g, '\n')).split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (t.startsWith('```')) {
      flushPara()
      const lang = t.slice(3).trim().toLowerCase()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++])
      const text = buf.join('\n')
      const spec = lang === 'chart' ? parseChartSpec(text) : null
      blocks.push(spec ? { kind: 'chart', spec } : { kind: 'code', text })
      continue
    }
    if (t === '') {
      flushPara()
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t)
    if (h) {
      flushPara()
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] })
      continue
    }
    if (t.startsWith('|') && i + 1 < lines.length && SEPARATOR_ROW.test(lines[i + 1].trim())) {
      flushPara()
      const header = splitCells(t)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        if (!SEPARATOR_ROW.test(lines[i].trim())) rows.push(splitCells(lines[i]))
        i++
      }
      i--
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    const ul = /^[-*•]\s+(.*)$/.exec(t)
    if (ul) {
      flushPara()
      const items = [ul[1]]
      while (i + 1 < lines.length) {
        const n = /^[-*•]\s+(.*)$/.exec(lines[i + 1].trim())
        if (!n) break
        items.push(n[1])
        i++
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(t)
    if (ol) {
      flushPara()
      const items = [ol[1]]
      while (i + 1 < lines.length) {
        const n = /^\d+[.)]\s+(.*)$/.exec(lines[i + 1].trim())
        if (!n) break
        items.push(n[1])
        i++
      }
      blocks.push({ kind: 'ol', items })
      continue
    }
    para.push(t)
  }
  flushPara()
  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g

/**
 * Inline markdown. With `autolink` on, plain text runs (and bold runs — the
 * prompt asks for "**HQ25-68952** — name") go through AutolinkedText, so a
 * friendly id the host's entity-room registry knows becomes a link to the
 * record in THIS app (NavigationContext decides the URL).
 */
export function renderInline(text: string, autolink = false): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  const plain = (t: string): ReactNode =>
    autolink ? <AutolinkedText key={k++} text={t} plain /> : t
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(plain(text.slice(last, idx)))
    const tok = m[0]
    if (tok.startsWith('**')) out.push(<strong key={k++}>{plain(tok.slice(2, -2))}</strong>)
    else if (tok.startsWith('`'))
      out.push(
        <code
          key={k++}
          className='rounded bg-black/[0.06] px-1 py-px font-mono text-[0.92em] dark:bg-white/10'
        >
          {tok.slice(1, -1)}
        </code>
      )
    else if (tok.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      if (lm && /^\/(?!\/)/.test(lm[2]))
        out.push(<InAppLink key={k++} href={lm[2]} label={lm[1]} />)
      else if (lm && /^https?:\/\//.test(lm[2]))
        out.push(
          <a
            key={k++}
            href={lm[2]}
            className='underline underline-offset-2'
            target='_blank'
            rel='noreferrer'
          >
            {lm[1]}
          </a>
        )
      else out.push(tok)
    } else out.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    last = idx + tok.length
  }
  if (last < text.length) out.push(plain(text.slice(last)))
  return out
}

/**
 * A link to a page of THIS app (a path, e.g. Ask AI citing a help video
 * moment `/help-videos?watch=…&t=42`): navigates through the host's router
 * instead of opening a new tab. `/help-videos` follows the host's
 * NavigationContext.helpVideosPath when it mounts the library elsewhere.
 * Ctrl/⌘/middle click keep the browser's own new-tab behaviour.
 */
export function inAppHref(href: string, helpVideosPath?: string): string {
  if (helpVideosPath && helpVideosPath !== '/help-videos' && /^\/help-videos(?=[?#/]|$)/.test(href))
    return `${helpVideosPath}${href.slice('/help-videos'.length)}`
  return href
}

function InAppLink({ href, label }: { href: string; label: string }) {
  const nav = useNavigation()
  const to = inAppHref(href, nav.helpVideosPath)
  return (
    <a
      href={to}
      data-ai-link='in-app'
      className='underline underline-offset-2'
      onClick={(e) => {
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        )
          return
        e.preventDefault()
        nav.navigate(to)
      }}
    >
      {label}
    </a>
  )
}

function TableBlock({
  header,
  rows,
  autolink
}: {
  header: string[]
  rows: string[][]
  autolink: boolean
}) {
  const cols = header.length
  return (
    <div data-ai-table className='my-1.5'>
      {/* Phone: one card per row */}
      <ul className='flex flex-col gap-1.5 sm:hidden'>
        {rows.map((row, ri) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static content
          <li
            key={ri}
            className='rounded-lg border border-black/10 bg-background/60 px-2.5 py-2 dark:border-white/10'
          >
            <div className='font-semibold leading-snug'>{renderInline(row[0] ?? '', autolink)}</div>
            {row.slice(1, cols).map((cell, ci) =>
              cell ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: static content
                <div
                  key={ci}
                  className='mt-1 grid grid-cols-[minmax(0,34%)_1fr] gap-2 text-[0.94em] leading-snug'
                >
                  <span className='text-muted-foreground'>{header[ci + 1]}</span>
                  <span className='min-w-0 break-words'>{renderInline(cell, autolink)}</span>
                </div>
              ) : null
            )}
          </li>
        ))}
      </ul>
      {/* Wider: a real table in its own scroller */}
      <div className='hidden overflow-x-auto sm:block'>
        <table className='w-auto min-w-[50%] text-left'>
          <thead>
            <tr className='border-b border-black/10 text-[0.85em] uppercase tracking-wide text-muted-foreground dark:border-white/10'>
              {header.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static content
                <th key={i} className='py-1 pr-4 font-medium'>
                  {renderInline(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className='divide-y divide-black/5 dark:divide-white/10'>
            {rows.map((row, ri) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static content
              <tr key={ri} className='align-top'>
                {header.map((_, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static content
                  <td key={ci} className='max-w-[28rem] py-1 pr-4'>
                    {renderInline(row[ci] ?? '', autolink)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const CHART_COLORS = [
  '#0ea5e9',
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#14b8a6',
  '#f97316'
]

/** A chart the answer attached — bar/line/pie over {label, value} points,
 *  recharts, sized to the bubble. Theme-neutral inks so it reads in both modes. */
function ChartBlock({ spec }: { spec: ChartSpec }) {
  const [width, setWidth] = useState(0)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width))
    ro.observe(el)
  }, [])
  const height = spec.type === 'pie' ? 220 : 200
  const w = Math.max(240, Math.min(720, width || 400))
  const fmt = (n: number) =>
    Math.abs(n) >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : Math.abs(n) >= 1e3
        ? `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k`
        : n.toLocaleString()
  const tip = {
    contentStyle: {
      background: '#0f172a',
      border: '1px solid #334155',
      borderRadius: 6,
      color: '#f8fafc',
      fontSize: 12
    },
    itemStyle: { color: '#f8fafc' },
    labelStyle: { color: '#cbd5e1' }
  }
  return (
    <div ref={ref} data-ai-chart={spec.type} className='my-2 w-full'>
      {spec.title && (
        <div className='mb-1 text-[0.9em] font-medium text-muted-foreground'>{spec.title}</div>
      )}
      {spec.type === 'pie' ? (
        <PieChart width={w} height={height}>
          <Pie
            data={spec.data}
            dataKey='value'
            nameKey='label'
            cx='50%'
            cy='50%'
            outerRadius={80}
            label={({ name, percent }) => `${name} ${Math.round((percent ?? 0) * 100)}%`}
            labelLine={false}
          >
            {spec.data.map((d, i) => (
              <Cell key={d.label} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip {...tip} formatter={(v) => fmt(Number(v))} />
        </PieChart>
      ) : spec.type === 'line' ? (
        <LineChart width={w} height={height} data={spec.data} margin={{ left: 4, right: 12 }}>
          <CartesianGrid strokeDasharray='3 3' stroke='currentColor' opacity={0.12} />
          <XAxis dataKey='label' tick={{ fontSize: 11 }} interval='preserveStartEnd' />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} width={44} />
          <Tooltip {...tip} formatter={(v) => fmt(Number(v))} />
          <Line
            type='monotone'
            dataKey='value'
            stroke='#0ea5e9'
            strokeWidth={2}
            dot={spec.data.length <= 12}
          />
        </LineChart>
      ) : (
        <BarChart width={w} height={height} data={spec.data} margin={{ left: 4, right: 12 }}>
          <CartesianGrid strokeDasharray='3 3' stroke='currentColor' opacity={0.12} />
          <XAxis
            dataKey='label'
            tick={{ fontSize: 11 }}
            interval={0}
            angle={spec.data.length > 8 ? -30 : 0}
            textAnchor={spec.data.length > 8 ? 'end' : 'middle'}
            height={spec.data.length > 8 ? 56 : 30}
          />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} width={44} />
          <Tooltip {...tip} formatter={(v) => fmt(Number(v))} />
          <Bar dataKey='value' fill='#0ea5e9' radius={[3, 3, 0, 0]} />
        </BarChart>
      )}
    </div>
  )
}

export function AiMarkdown({
  content,
  className,
  autolink
}: {
  content: string
  className?: string
  /** Turn friendly ids into record links. Default: on whenever a NivaroProvider is present. */
  autolink?: boolean
}) {
  const blocks = useMemo(() => parseAiMarkdown(content), [content])
  const client = useOptionalNivaroClient()
  const link = autolink ?? client != null
  return (
    <div data-ai-markdown className={cn('space-y-1.5 [&_strong]:font-semibold', className)}>
      {blocks.map((b, i) => {
        const key = `${b.kind}-${i}`
        switch (b.kind) {
          case 'h':
            return (
              <p key={key} className={cn('font-semibold', b.level <= 2 ? 'text-[1.05em]' : '')}>
                {renderInline(b.text, link)}
              </p>
            )
          case 'ul':
            return (
              <ul key={key} className='list-disc space-y-0.5 pl-5'>
                {b.items.map((it, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static content
                  <li key={j}>{renderInline(it, link)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key} className='list-decimal space-y-0.5 pl-5'>
                {b.items.map((it, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static content
                  <li key={j}>{renderInline(it, link)}</li>
                ))}
              </ol>
            )
          case 'code':
            return (
              <pre
                key={key}
                className='overflow-x-auto rounded-md bg-black/[0.05] p-2 font-mono text-[0.9em] dark:bg-white/10'
              >
                {b.text}
              </pre>
            )
          case 'table':
            return <TableBlock key={key} header={b.header} rows={b.rows} autolink={link} />
          case 'chart':
            return <ChartBlock key={key} spec={b.spec} />
          default:
            return <p key={key}>{renderInline(b.text, link)}</p>
        }
      })}
    </div>
  )
}
