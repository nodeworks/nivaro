import { useMutation } from '@tanstack/react-query'
import { Loader2, Send, Sparkles, Wrench } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SimpleMarkdown } from '@/pages/PageView'

interface TraceEntry {
  tool: string
  input: Record<string, unknown>
  summary: string
}

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  trace?: TraceEntry[]
}

/** SimpleMarkdown plus pipe-table support — AI answers lean on tables. */
function ChatMarkdown({ content }: { content: string }) {
  const lines = content.split('\n')
  const blocks: ReactNode[] = []
  let buffer: string[] = []
  let tableRows: string[] = []

  const flushText = (key: string) => {
    if (buffer.length === 0) return
    blocks.push(<SimpleMarkdown key={key} content={buffer.join('\n')} />)
    buffer = []
  }
  const flushTable = (key: string) => {
    if (tableRows.length === 0) return
    const parse = (line: string) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
    const header = parse(tableRows[0])
    const body = tableRows
      .slice(1)
      .filter((r) => !/^\|?[\s:|-]+\|?$/.test(r))
      .map(parse)
    blocks.push(
      <div key={key} className='my-2 overflow-x-auto'>
        <table className='w-auto min-w-[50%] text-left text-[12.5px]'>
          <thead>
            <tr className='border-b border-slate-200 text-[11px] text-slate-500 dark:border-border'>
              {header.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static content
                <th key={i} className='py-1 pr-4 font-medium'>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border'>
            {body.map((row, ri) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static content
              <tr key={ri}>
                {row.map((c, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static content
                  <td key={ci} className='py-1 pr-4 text-slate-700 dark:text-slate-300'>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
    tableRows = []
  }

  lines.forEach((line, i) => {
    if (line.trimStart().startsWith('|')) {
      flushText(`t-${i}`)
      tableRows.push(line.trim())
    } else {
      flushTable(`tb-${i}`)
      buffer.push(line)
    }
  })
  flushTable('tb-end')
  flushText('t-end')
  return <div className='space-y-1'>{blocks}</div>
}

const SUGGESTIONS = [
  'How many records are in each collection?',
  'What changed in the last 7 days?',
  'Show the 5 most recent workflows and their states'
]

export function AskPage() {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const send = useMutation({
    mutationFn: (history: ChatTurn[]) =>
      api
        .post<{ data: { reply: string; trace: TraceEntry[] } }>('/ai/chat', {
          messages: history.map((t) => ({ role: t.role, content: t.content }))
        })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      setTurns((prev) => [...prev, { role: 'assistant', content: data.reply, trace: data.trace }])
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Chat request failed')
      setTurns((prev) => prev.slice(0, -1)) // roll back the optimistic user turn
    }
  })

  function submit(text?: string) {
    const content = (text ?? input).trim()
    if (!content || send.isPending) return
    const next = [...turns, { role: 'user' as const, content }]
    setTurns(next)
    setInput('')
    send.mutate(next)
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new turns
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns.length, send.isPending])

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Sparkles className='h-4 w-4 text-nvr-cyan' />
          <div>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Ask your data
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Answers come from live queries, permission-checked as you. Read-only.
            </p>
          </div>
          {turns.length > 0 && (
            <Button size='sm' variant='ghost' className='ml-auto' onClick={() => setTurns([])}>
              New chat
            </Button>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        className='flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-background'
      >
        <div className='mx-auto w-full max-w-3xl space-y-4 p-6'>
          {turns.length === 0 && (
            <div className='pt-16 text-center'>
              <Sparkles className='mx-auto h-8 w-8 text-slate-300' />
              <p className='mt-3 text-[14px] font-medium text-slate-600 dark:text-slate-300'>
                Ask anything about your data
              </p>
              <div className='mx-auto mt-4 flex max-w-md flex-col gap-2'>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type='button'
                    onClick={() => submit(s)}
                    className='rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-[13px] text-slate-600 transition-colors hover:border-[#00ceff] dark:border-border dark:bg-card dark:text-slate-300'
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript
            <div
              key={i}
              className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-xl px-4 py-2.5 text-[13.5px]',
                  t.role === 'user'
                    ? 'bg-nvr-navy text-white'
                    : 'border border-slate-200 bg-white text-slate-800 dark:border-border dark:bg-card dark:text-slate-200'
                )}
              >
                {t.role === 'assistant' ? (
                  <>
                    <ChatMarkdown content={t.content} />
                    {t.trace && t.trace.length > 0 && (
                      <div className='mt-2 flex flex-wrap gap-1 border-t border-slate-100 pt-2 dark:border-border'>
                        {t.trace.map((tr, ti) => (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: static
                            key={ti}
                            title={JSON.stringify(tr.input)}
                            className='inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 dark:bg-muted'
                          >
                            <Wrench className='h-2.5 w-2.5' />
                            {tr.tool}: {tr.summary}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <span className='whitespace-pre-wrap'>{t.content}</span>
                )}
              </div>
            </div>
          ))}

          {send.isPending && (
            <div className='flex justify-start'>
              <div className='flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13px] text-slate-400 dark:border-border dark:bg-card'>
                <Loader2 className='h-3.5 w-3.5 animate-spin' /> Querying your data…
              </div>
            </div>
          )}
        </div>
      </div>

      <div className='shrink-0 border-t border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='mx-auto flex w-full max-w-3xl items-end gap-2'>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={1}
            placeholder='e.g. How many workflows are waiting on manager approval?'
            className='max-h-32 flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[#00ceff] dark:border-border dark:bg-background'
          />
          <Button size='sm' disabled={!input.trim() || send.isPending} onClick={() => submit()}>
            <Send className='h-3.5 w-3.5' />
          </Button>
        </div>
      </div>
    </div>
  )
}
