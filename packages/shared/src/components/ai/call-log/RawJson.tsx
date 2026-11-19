import { Check, ChevronRight, Copy } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../../lib/utils'

/**
 * A stored request / response body, readable: a JSON tree with each object
 * and list folding open, values coloured by kind, long strings cut with
 * "show all", and one Copy for the whole body. Keys listed in `foldKeys`
 * (the system prompt, tool schemas) start folded. Bodies come masked from
 * the server.
 */

const STRING_PREVIEW = 600

function Str({ value }: { value: string }) {
  const [all, setAll] = useState(false)
  const long = value.length > STRING_PREVIEW
  const shown = long && !all ? `${value.slice(0, STRING_PREVIEW)}…` : value
  return (
    <span className='whitespace-pre-wrap break-words text-emerald-800 dark:text-[#b9d3a6]'>
      "{shown}"
      {long && (
        <button
          type='button'
          onClick={() => setAll(!all)}
          className='ml-1.5 rounded px-1 font-sans text-[10.5px] text-nvr-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
        >
          {all ? 'show less' : `show all ${value.length.toLocaleString('en-US')} characters`}
        </button>
      )}
    </span>
  )
}

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className='text-violet-700 dark:text-[#c8b6e2]'>null</span>
  if (typeof value === 'string') return <Str value={value} />
  if (typeof value === 'number')
    return <span className='text-sky-800 dark:text-[#b3c4dd]'>{String(value)}</span>
  if (typeof value === 'boolean')
    return <span className='text-violet-700 dark:text-[#c8b6e2]'>{String(value)}</span>
  return <span>{String(value)}</span>
}

function Node({
  name,
  value,
  depth,
  foldKeys
}: {
  name: string | null
  value: unknown
  depth: number
  foldKeys: Set<string>
}) {
  const isArr = Array.isArray(value)
  const isObj = !!value && typeof value === 'object'
  const startOpen = depth < 2 && !(name && foldKeys.has(name))
  const [open, setOpen] = useState(startOpen)
  const label = name != null && (
    <span className='text-slate-500 dark:text-muted-foreground'>
      {/^\d+$/.test(name) ? name : `"${name}"`}:{' '}
    </span>
  )
  if (!isObj)
    return (
      <div className='pl-4'>
        {label}
        <Leaf value={value} />
      </div>
    )
  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>)
  const summary = isArr
    ? `[${entries.length} ${entries.length === 1 ? 'item' : 'items'}]`
    : `{${entries.length} ${entries.length === 1 ? 'key' : 'keys'}}`
  return (
    <div className={depth > 0 ? 'pl-4' : ''}>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className='-ml-4 inline-flex items-center gap-0.5 rounded text-left hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted'
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-slate-400 transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-90'
          )}
          aria-hidden
        />
        {label}
        {!open && <span className='text-slate-400 dark:text-muted-foreground'>{summary}</span>}
        {open && <span className='text-slate-400'>{isArr ? '[' : '{'}</span>}
      </button>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} foldKeys={foldKeys} />
          ))}
          <div className='text-slate-400'>{isArr ? ']' : '}'}</div>
        </>
      )}
    </div>
  )
}

export function RawJson({
  value,
  text,
  cut,
  foldKeys = [],
  label
}: {
  value: unknown
  /** The body as stored when it could not be read as JSON. */
  text?: string | null
  cut?: boolean
  foldKeys?: string[]
  label: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        value != null ? JSON.stringify(value, null, 2) : (text ?? '')
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section
      aria-label={label}
      className='min-w-0 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <header className='flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-border/60'>
        <h4 className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>{label}</h4>
        {cut && (
          <span
            className='rounded bg-amber-50 px-1.5 py-px text-[10.5px] text-amber-800 dark:bg-[#d4936a]/10 dark:text-[#e2b192]'
            data-tip='The log keeps the first 48 KB of a request and 16 KB of a response'
          >
            cut at the log's size limit
          </span>
        )}
        <button
          type='button'
          onClick={() => void copy()}
          className='ml-auto inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
        >
          {copied ? (
            <Check className='h-3 w-3' aria-hidden />
          ) : (
            <Copy className='h-3 w-3' aria-hidden />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <div className='max-h-[60vh] overflow-auto px-3 py-2 pl-7 font-mono text-[11px] leading-[1.55]'>
        {value != null ? (
          <Node name={null} value={value} depth={0} foldKeys={new Set(foldKeys)} />
        ) : text ? (
          <pre className='whitespace-pre-wrap break-words'>{text}</pre>
        ) : (
          <span className='font-sans text-slate-500'>Not stored.</span>
        )}
      </div>
    </section>
  )
}
