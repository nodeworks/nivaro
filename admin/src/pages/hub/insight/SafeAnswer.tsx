import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router'

/**
 * Ask the Hub's answer, drawn without trusting it (defence in depth beside the server's own
 * rewrite, services/hub/insight/ask.ts sanitizeAnswer): no images at all, no raw HTML (text only,
 * React escapes it), and a link is clickable only when it points at a Hub page (`/hub…`, opened
 * in-app); any other link shows as its text. Paragraphs, lists, small tables, **bold** and `code`.
 */

/**
 * A Hub page path, resolved, or null — the twin of the server's hubPath (services/hub/insight/ask.ts),
 * character for character:
 *  - decoded at most once; anything still holding `%` after that is refused;
 *  - backslashes and control characters are refused;
 *  - the path is resolved with `new URL(s, 'http://hub.invalid')`: its origin must stay
 *    `http://hub.invalid` (so `//evil`, `https:…` are refused) and its pathname must be `/hub` or
 *    start with `/hub/` (so `/hub-link`, and `/hub/../x` that resolves outside, are refused);
 *  - the answer is the RESOLVED pathname + search, never the raw input.
 * Pure.
 */
export function hubLinkPath(raw: string): string | null {
  let s = String(raw ?? '').trim()
  if (!s.startsWith('/') || s.length > 500) return null
  // Decode at most once: anything still encoded after that is refused, never decoded further.
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s)
    } catch {
      return null
    }
    if (s.includes('%')) return null
  }
  if (s.includes('\\') || [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    return null
  // Let the URL parser resolve it (dot segments, `//host`, schemes) against a throwaway origin.
  let u: URL
  try {
    u = new URL(s, 'http://hub.invalid')
  } catch {
    return null
  }
  if (u.origin !== 'http://hub.invalid') return null
  if (u.pathname !== '/hub' && !u.pathname.startsWith('/hub/')) return null
  return `${u.pathname}${u.search}`
}

/** Whether a link target is a Hub page this app may open. Pure. */
export function isHubPath(href: string): boolean {
  return hubLinkPath(href) !== null
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(!?\[[^\]]*\]\([^)]*\))/g
  let last = 0
  let i = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const tok = m[0]
    const k = `${key}-${i++}`
    if (tok.startsWith('`'))
      out.push(
        <code key={k} className='rounded bg-slate-100 px-1 font-mono text-[12px] dark:bg-muted'>
          {tok.slice(1, -1)}
        </code>
      )
    else if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('!')) {
      // An image never renders.
    } else {
      const lm = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(tok)
      const label = lm?.[1] ?? ''
      const href = hubLinkPath((lm?.[2] ?? '').trim())
      out.push(
        href ? (
          <Link
            key={k}
            to={href}
            className='font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-200'
          >
            {label || href}
          </Link>
        ) : (
          <Fragment key={k}>{label}</Fragment>
        )
      )
    }
    last = at + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

export function SafeAnswer({ text }: { text: string }) {
  const lines = String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let n = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const k = `b${n++}`
    if (line.trim().startsWith('|')) {
      const rows: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++])
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
      const [head, ...rest] = body
      blocks.push(
        <div key={k} className='overflow-x-auto'>
          <table className='w-full border-collapse text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-left text-slate-500 dark:border-border dark:text-muted-foreground'>
                {cells(head ?? '').map((c, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity of their own
                  <th key={j} className='px-2 py-1 font-medium'>
                    {inline(c, `${k}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rest.map((r, ri) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
                  key={ri}
                  className='border-b border-slate-100 last:border-b-0 dark:border-border'
                >
                  {cells(r).map((c, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity of their own
                    <td key={j} className='px-2 py-1 tabular-nums'>
                      {inline(c, `${k}r${ri}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = []
      const ordered = /^\s*\d+\./.test(line)
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''))
      const Tag = ordered ? 'ol' : 'ul'
      blocks.push(
        <Tag key={k} className={`m-0 space-y-0.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity of their own
            <li key={j}>{inline(it, `${k}i${j}`)}</li>
          ))}
        </Tag>
      )
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('|') &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i])
    )
      para.push(lines[i++].replace(/^#+\s*/, ''))
    blocks.push(
      <p key={k} className='m-0'>
        {inline(para.join(' '), k)}
      </p>
    )
  }
  return <div className='space-y-2 text-[13px] leading-relaxed'>{blocks}</div>
}
