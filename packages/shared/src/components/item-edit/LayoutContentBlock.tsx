import { AlertTriangle, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FieldGroup } from './types'

/**
 * Layout content block (#53): a field group of type 'content' renders admin-
 * authored text between sections — help notes, warnings, labelled dividers.
 * Minimal inline markup only (**bold**, [text](https://…) links, blank-line
 * paragraphs); it's guidance copy, not a document.
 */

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  // Bold + https links; everything else passes through as plain text.
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
  let last = 0
  let k = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push(<span key={k++}>{text.slice(last, i)}</span>)
    if (m[1] !== undefined) {
      out.push(
        <strong key={k++} className='font-semibold'>
          {m[1]}
        </strong>
      )
    } else {
      out.push(
        <a
          key={k++}
          href={m[3]}
          target='_blank'
          rel='noreferrer'
          className='text-nvr-navy underline underline-offset-2 dark:text-nvr-cyan'
        >
          {m[2]}
        </a>
      )
    }
    last = i + m[0].length
  }
  if (last < text.length) out.push(<span key={k++}>{text.slice(last)}</span>)
  return out
}

export function LayoutContentBlock({ group }: { group: FieldGroup }) {
  const tone = group.content_tone ?? 'info'
  const text = (group.content ?? '').trim()

  if (tone === 'divider') {
    return (
      <div className='flex items-center gap-3 py-1' data-content-block={group.key}>
        <span className='h-px flex-1 bg-slate-200 dark:bg-border' />
        {(text || group.label) && (
          <span className='text-[11px] font-medium uppercase tracking-wide text-slate-400'>
            {text || group.label}
          </span>
        )}
        <span className='h-px flex-1 bg-slate-200 dark:bg-border' />
      </div>
    )
  }

  if (!text) return null
  const paragraphs = text.split(/\n{2,}/)
  const warn = tone === 'warn'
  return (
    <div
      data-content-block={group.key}
      className={`flex gap-2.5 rounded-lg border px-3.5 py-2.5 ${
        warn
          ? 'border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10'
          : 'border-slate-200 bg-slate-50/70 dark:border-border dark:bg-muted/40'
      }`}
    >
      {warn ? (
        <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500' />
      ) : (
        <Info className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
      )}
      <div className='min-w-0 space-y-1.5'>
        {group.label && group.label !== group.key && (
          <p
            className={`text-[12.5px] font-semibold ${
              warn ? 'text-amber-800 dark:text-amber-300' : 'text-slate-800 dark:text-foreground'
            }`}
          >
            {group.label}
          </p>
        )}
        {paragraphs.map((p, i) => (
          <p
            // biome-ignore lint/suspicious/noArrayIndexKey: static paragraph list
            key={i}
            className={`whitespace-pre-wrap text-[12.5px] leading-relaxed ${
              warn ? 'text-amber-700 dark:text-amber-300/90' : 'text-slate-600 dark:text-muted-foreground'
            }`}
          >
            {renderInline(p)}
          </p>
        ))}
      </div>
    </div>
  )
}
