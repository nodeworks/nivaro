import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'

/**
 * Draft field help text (#1912) — collection Settings tab. Lists the fields
 * with no help text, asks the AI for drafts built from each field's type,
 * choices, rules, relations and the data guide, and lets an admin accept
 * (as drafted or edited) or skip each one. Accepting writes the field's
 * note; the activity entry keeps the previous text.
 */

interface Candidate {
  field: string
  label: string
  type: string
  required: boolean
}

interface Draft {
  field: string
  label: string
  text: string
  basis: string | null
}

type RowState = { text: string; status: 'pending' | 'saved' | 'skipped' }

const errOf = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

export function HelpTextDraftsSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [drafts, setDrafts] = useState<Draft[] | null>(null)

  const { data: candidates } = useQuery({
    queryKey: ['ai-design-help-candidates', tableName],
    queryFn: () =>
      api
        .get<{ data: { candidates: Candidate[] } }>(`/ai-design/help-text/${tableName}`)
        .then((r) => r.data.data.candidates),
    enabled: !!tableName
  })

  const draft = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { drafts: Draft[] } }>(`/ai-design/help-text/${tableName}/draft`, {})
        .then((r) => r.data.data.drafts),
    onSuccess: (list) => {
      setDrafts(list)
      setRows(Object.fromEntries(list.map((d) => [d.field, { text: d.text, status: 'pending' }])))
      if (list.length === 0) toast.info('Nothing useful to add beyond the labels')
    },
    onError: (e) => toast.error(errOf(e, 'Drafting failed'))
  })

  const accept = useMutation({
    mutationFn: ({ field, text }: { field: string; text: string }) =>
      api.post(`/ai-design/help-text/${tableName}/apply`, { field, text }),
    onSuccess: (_d, { field }) => {
      setRows((r) => ({ ...r, [field]: { ...r[field], status: 'saved' } }))
      qc.invalidateQueries({ queryKey: ['ai-design-help-candidates', tableName] })
    },
    onError: (e) => toast.error(errOf(e, 'Could not save the help text'))
  })

  const pending = (drafts ?? []).filter((d) => rows[d.field]?.status === 'pending')

  return (
    <div
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-ai-help-text
    >
      <div className='flex items-center justify-between gap-3 px-4 py-3'>
        <div>
          <p className='flex items-center gap-1.5 text-[13px] font-medium text-slate-800 dark:text-foreground'>
            <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' /> Field help text
          </p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            {candidates === undefined
              ? 'Checking fields…'
              : candidates.length === 0
                ? 'Every visible field has help text.'
                : `${candidates.length} field${candidates.length === 1 ? ' has' : 's have'} no help text. Draft it from each field's choices, rules and relations, then accept, edit or skip each one.`}
          </p>
        </div>
        {!!candidates?.length && (
          <button
            type='button'
            disabled={draft.isPending}
            onClick={() => draft.mutate()}
            className='shrink-0 rounded bg-nvr-cyan px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50'
          >
            {draft.isPending ? 'Drafting…' : drafts ? 'Draft again' : 'Draft help text'}
          </button>
        )}
      </div>
      {drafts && drafts.length > 0 && (
        <div className='border-t border-slate-100 dark:border-border'>
          {pending.length > 1 && (
            <div className='flex justify-end px-4 pt-2'>
              <button
                type='button'
                disabled={accept.isPending}
                onClick={() => {
                  for (const d of pending)
                    accept.mutate({ field: d.field, text: rows[d.field].text })
                }}
                className='text-[11.5px] text-nvr-cyan hover:underline disabled:opacity-50'
              >
                Accept all {pending.length}
              </button>
            </div>
          )}
          <ul className='divide-y divide-slate-100 dark:divide-border'>
            {drafts.map((d) => {
              const row = rows[d.field]
              if (!row) return null
              return (
                <li key={d.field} className='px-4 py-2.5'>
                  <div className='flex items-baseline justify-between gap-2'>
                    <p className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                      {d.label}{' '}
                      <span className='font-mono text-[10.5px] text-slate-400'>{d.field}</span>
                    </p>
                    {d.basis && <p className='text-[10.5px] text-slate-400'>from {d.basis}</p>}
                  </div>
                  {row.status === 'pending' ? (
                    <>
                      <textarea
                        value={row.text}
                        rows={2}
                        onChange={(e) =>
                          setRows((r) => ({ ...r, [d.field]: { ...row, text: e.target.value } }))
                        }
                        className='mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1 text-[12px] dark:border-border dark:bg-background'
                        aria-label={`Help text for ${d.label}`}
                      />
                      <div className='mt-1 flex gap-2'>
                        <button
                          type='button'
                          disabled={accept.isPending || !row.text.trim()}
                          onClick={() => accept.mutate({ field: d.field, text: row.text })}
                          className='rounded border border-slate-300 px-2 py-0.5 text-[11.5px] font-medium text-slate-700 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-200'
                        >
                          {row.text.trim() === d.text ? 'Accept' : 'Save edit'}
                        </button>
                        <button
                          type='button'
                          onClick={() =>
                            setRows((r) => ({ ...r, [d.field]: { ...row, status: 'skipped' } }))
                          }
                          className='text-[11.5px] text-slate-500 hover:underline'
                        >
                          Skip
                        </button>
                      </div>
                    </>
                  ) : (
                    <p
                      className={
                        row.status === 'saved'
                          ? 'mt-0.5 text-[12px] text-emerald-600'
                          : 'mt-0.5 text-[12px] text-slate-400 line-through'
                      }
                    >
                      {row.text}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
