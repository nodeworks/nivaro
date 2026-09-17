import { type ReactNode, useMemo } from 'react'
import { useOptionalNivaroClient } from '../../context'
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
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++])
      blocks.push({ kind: 'code', text: buf.join('\n') })
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
      if (lm && /^(https?:\/\/|\/)/.test(lm[2]))
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
          default:
            return <p key={key}>{renderInline(b.text, link)}</p>
        }
      })}
    </div>
  )
}
