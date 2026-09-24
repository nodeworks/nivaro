import { Check, ChevronDown, Copy } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../../../lib/utils'

/** Pretty-print a stored body: JSON strings re-indented, anything else as-is. */
export function pretty(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2)
    } catch {
      return v
    }
  }
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Past this many lines a block starts folded — the rest is one click away. */
export const FOLD_LINES = 40

/** The exact suffix `services/external-apis.ts` appends when a stored body
 *  hit the log's size cap — detecting it here (rather than a byte-length
 *  guess) is exact regardless of what the size cap is set to. */
const TRUNCATION_SUFFIX = '… [truncated]'

/** Whether a stored body was cut short at the log's size cap. Checked on the
 *  RAW value, before `pretty()` — a truncated JSON body is no longer valid
 *  JSON, so `pretty()` already falls back to showing it as-is with the
 *  marker visible; this drives the separate note. */
export function isTruncatedBody(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.endsWith(TRUNCATION_SUFFIX)
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type='button'
      aria-label={`Copy ${label.toLowerCase()}`}
      data-tip={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className='inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
    >
      {copied ? (
        <Check className='h-3 w-3' aria-hidden />
      ) : (
        <Copy className='h-3 w-3' aria-hidden />
      )}
    </button>
  )
}

/**
 * A labelled, monospace view of a request or response body with a copy
 * button. Long bodies start folded at FOLD_LINES with a "Show all" toggle —
 * `fold` false keeps the old fixed-height scroll box instead.
 */
export function CodeBlock({
  label,
  value,
  fold = false,
  className,
  truncated = false
}: {
  label: string
  value: string | null
  fold?: boolean
  className?: string
  /** The stored copy was cut short at the log's size cap — the value shown
   *  is real but partial. `isTruncatedBody(rawValue)` computes this. */
  truncated?: boolean
}) {
  const lines = value ? value.split('\n').length : 0
  const foldable = fold && lines > FOLD_LINES
  const [open, setOpen] = useState(false)
  const shown =
    value && foldable && !open ? value.split('\n').slice(0, FOLD_LINES).join('\n') : value
  return (
    <div className={cn('min-w-0', className)} data-ic-code={label}>
      <div className='mb-1 flex min-h-6 items-center gap-2'>
        <p className='text-[11.5px] font-semibold text-muted-foreground'>{label}</p>
        {value && (
          <span className='text-[11px] tabular-nums text-muted-foreground'>
            {lines} line{lines === 1 ? '' : 's'}
          </span>
        )}
        {value && (
          <span className='ml-auto'>
            <CopyButton text={value} label={label} />
          </span>
        )}
      </div>
      {value ? (
        <>
          <pre
            className={cn(
              'overflow-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-foreground',
              !fold && 'max-h-48'
            )}
          >
            {shown}
          </pre>
          {foldable && (
            <button
              type='button'
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className='mt-1 inline-flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', open && 'rotate-180')}
                aria-hidden
              />
              {open ? 'Show less' : `Show all ${lines} lines`}
            </button>
          )}
          {truncated && (
            <p className='mt-1 text-[11px] italic text-muted-foreground' data-ic-truncated={label}>
              Truncated — only the first part of this body was kept.
            </p>
          )}
        </>
      ) : (
        <p className='text-[11.5px] italic text-muted-foreground'>Nothing stored</p>
      )}
    </div>
  )
}

/**
 * A request/response header set as a two-column key/value table — mono
 * throughout (every value here is a machine one), the key column tinted so
 * scanning a long list stays easy. `null`/empty reads as "None recorded",
 * never a blank table.
 */
export function HeaderTable({
  headers,
  label = 'Headers'
}: {
  headers: Record<string, string> | null
  label?: string
}) {
  const entries = headers ? Object.entries(headers) : []
  return (
    <div className='min-w-0' data-ic-headers={label}>
      <p className='mb-1 text-[11.5px] font-semibold text-muted-foreground'>{label}</p>
      {entries.length === 0 ? (
        <p className='text-[11.5px] italic text-muted-foreground'>None recorded</p>
      ) : (
        <div className='overflow-hidden rounded-md border border-border'>
          <table className='w-full text-[11px]'>
            <tbody className='divide-y divide-border'>
              {entries.map(([k, v]) => (
                <tr key={k}>
                  <td className='w-1/3 whitespace-nowrap bg-muted/40 px-2 py-1 align-top font-mono font-medium text-foreground'>
                    {k}
                  </td>
                  <td className='break-all px-2 py-1 font-mono text-muted-foreground'>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
