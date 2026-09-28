import { Check, Code2, Copy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useOptionalNivaroClient } from '../context'
import { buildCopyAs, type CopyAsInput } from '../lib/copy-as'
import { cn } from '../lib/utils'
import { HighlightedCode } from './item-edit/HighlightedCode'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

type Tab = 'curl' | 'sdk' | 'graphql'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'curl', label: 'curl' },
  { key: 'sdk', label: 'SDK' },
  { key: 'graphql', label: 'GraphQL' }
]

/**
 * "Copy as …" (#654): the request behind a list or a record, as a curl
 * command, an SDK call and a GraphQL document, each ready to paste. The
 * token is always the `NIVARO_TOKEN` placeholder, never the viewer's own.
 */
export function CopyAsButton({
  collection,
  itemId,
  list,
  fields,
  compact,
  className
}: Omit<CopyAsInput, 'origin'> & {
  /** Icon-only, borderless — for the record header's tool group. */
  compact?: boolean
  className?: string
}) {
  const client = useOptionalNivaroClient()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('curl')
  const [copied, setCopied] = useState<Tab | null>(null)
  const origin = useMemo(() => {
    const url = client?.url?.replace(/\/+$/, '')
    if (url) return url
    return typeof window === 'undefined' ? '' : window.location.origin
  }, [client])
  const snippets = useMemo(
    () => buildCopyAs({ origin, collection, itemId, list, fields }),
    [origin, collection, itemId, list, fields]
  )
  const text = snippets[tab]

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tab)
      setTimeout(() => setCopied(null), 1600)
    } catch {
      toast.error('Could not copy — select the text and copy it yourself')
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='Copy this request as curl, SDK or GraphQL'
          title='Copy as curl / SDK / GraphQL'
          data-copy-as
          className={cn(
            compact
              ? 'inline-flex h-8 w-8 items-center justify-center transition-colors hover:bg-accent hover:text-accent-foreground'
              : 'flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800',
            className
          )}
        >
          <Code2 className='h-4 w-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[560px] max-w-[94vw] p-0' data-copy-as-panel>
        <div className='flex items-center gap-1 border-b border-border px-2 py-1.5'>
          {TABS.map((t) => (
            <button
              key={t.key}
              type='button'
              onClick={() => setTab(t.key)}
              data-copy-as-tab={t.key}
              aria-pressed={tab === t.key}
              className={cn(
                'rounded px-2 py-1 text-[12px] font-medium',
                tab === t.key
                  ? 'bg-nvr-cyan text-white'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {t.label}
            </button>
          ))}
          <span className='ml-auto text-[11px] text-muted-foreground'>
            {itemId ? 'this record' : 'this list, as filtered'}
          </span>
          <button
            type='button'
            onClick={() => void copy()}
            data-copy-as-copy
            className='inline-flex h-7 items-center gap-1 rounded-md border border-input px-2 text-[12px] hover:bg-muted'
          >
            {copied === tab ? <Check className='h-3.5 w-3.5' /> : <Copy className='h-3.5 w-3.5' />}
            {copied === tab ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre
          data-copy-as-code
          className='max-h-[360px] overflow-auto whitespace-pre bg-slate-50 p-3 font-mono text-[11.5px] leading-relaxed text-slate-800 dark:bg-[#0f172a] dark:text-slate-200'
        >
          <HighlightedCode kind={tab === 'graphql' ? 'query' : 'text'} text={text} />
        </pre>
        <p className='border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground'>
          Set <code className='font-mono'>NIVARO_TOKEN</code> to an API key or a static token; the
          snippet never carries yours.
        </p>
      </PopoverContent>
    </Popover>
  )
}
