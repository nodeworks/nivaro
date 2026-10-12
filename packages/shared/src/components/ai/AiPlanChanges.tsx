import { Download, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useApiFetchConfig, useOptionalNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * A plan's change report (#2002): every field it would change — or did — per
 * record, old → new. The server builds it for the person looking (a record
 * they cannot read shows as #id, a field they cannot read as hidden); this
 * only renders it, plus the same rows as an Excel download.
 */

export interface AiPlanChangeRow {
  step: number
  step_title: string
  collection: string
  id: string | null
  label: string
  field: string
  from: unknown
  to: unknown
  status: 'planned' | 'made' | 'undone'
}

const SHOWN = 100

function cellText(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function AiPlanChanges({
  planId,
  title,
  className
}: {
  planId: string
  title: string
  className?: string
}) {
  const client = useOptionalNivaroClient()
  const fetchCfg = useApiFetchConfig()
  const [rows, setRows] = useState<AiPlanChangeRow[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    if (!client) return
    let live = true
    client
      .request(
        get<{ data: { rows: AiPlanChangeRow[]; truncated: boolean } }>(
          `/ai/plans/${encodeURIComponent(planId)}/changes`
        )
      )
      .then((res) => {
        if (!live) return
        setRows(res?.data?.rows ?? [])
        setTruncated(!!res?.data?.truncated)
      })
      .catch((err: Error) => live && setError(err?.message || 'Could not load the changes'))
    return () => {
      live = false
    }
  }, [client, planId])

  const download = async () => {
    setDownloading(true)
    try {
      const resp = await fetch(
        `${fetchCfg.apiBase}/ai/plans/${encodeURIComponent(planId)}/changes.xlsx`,
        { headers: fetchCfg.authHeaders, credentials: fetchCfg.credentials }
      )
      if (!resp.ok) throw new Error(await resp.text())
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'plan'} - changes.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('The download failed')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div
      className={cn(
        'mt-2 rounded-md border border-amber-200/70 bg-white/70 dark:border-amber-800/60 dark:bg-card',
        className
      )}
      data-ai-plan-changes
    >
      <div className='flex items-center gap-2 border-b border-amber-200/70 px-2.5 py-1.5 dark:border-amber-800/60'>
        <span className='text-[11.5px] font-medium text-foreground'>
          {rows == null
            ? 'Changes'
            : `${rows.length.toLocaleString()} field change${rows.length === 1 ? '' : 's'}${truncated ? '+' : ''}`}
        </span>
        <button
          type='button'
          disabled={downloading || !rows?.length}
          onClick={() => void download()}
          className='ml-auto flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-40'
        >
          {downloading ? (
            <Loader2 className='h-3 w-3 animate-spin' />
          ) : (
            <Download className='h-3 w-3' />
          )}
          Excel
        </button>
      </div>
      {error && (
        <p className='px-2.5 py-1.5 text-[11.5px] text-rose-700 dark:text-rose-400'>{error}</p>
      )}
      {rows == null && !error && (
        <p className='flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] text-muted-foreground'>
          <Loader2 className='h-3 w-3 animate-spin' /> Loading…
        </p>
      )}
      {rows != null && rows.length === 0 && (
        <p className='px-2.5 py-1.5 text-[11.5px] text-muted-foreground'>
          No field changes — this plan only sends, posts or runs things.
        </p>
      )}
      {rows != null && rows.length > 0 && (
        <div className='max-h-72 overflow-auto'>
          <table className='w-full text-[11.5px]'>
            <thead className='sticky top-0 bg-muted text-left text-muted-foreground'>
              <tr>
                <th className='px-2 py-1 font-medium'>Step</th>
                <th className='px-2 py-1 font-medium'>Record</th>
                <th className='px-2 py-1 font-medium'>Field</th>
                <th className='px-2 py-1 font-medium'>Old</th>
                <th className='px-2 py-1 font-medium'>New</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, SHOWN).map((r) => (
                <tr
                  key={`${r.step}-${r.collection}-${r.id ?? 'new'}-${r.field}`}
                  className={cn(
                    'border-t border-border',
                    r.status === 'undone' && 'text-muted-foreground line-through'
                  )}
                >
                  <td className='px-2 py-1 tabular-nums text-muted-foreground'>{r.step}</td>
                  <td className='max-w-[160px] truncate px-2 py-1'>{r.label}</td>
                  <td className='px-2 py-1 font-mono text-[11px]'>{r.field}</td>
                  <td className='max-w-[160px] truncate px-2 py-1 text-muted-foreground'>
                    {cellText(r.from)}
                  </td>
                  <td className='max-w-[160px] truncate px-2 py-1'>{cellText(r.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > SHOWN && (
            <p className='border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground'>
              +{(rows.length - SHOWN).toLocaleString()} more — download Excel for every row.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
