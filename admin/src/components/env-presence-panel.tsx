import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface PresenceColumn {
  id: number | 'local'
  name: string
  environment: string | null
  state: 'ok' | 'no-token' | 'unreachable' | 'not-supported'
  note?: string
  set: Record<string, boolean>
}
interface PresenceRow {
  key: string
  extension: string
  name: string
  required: boolean
  secret: boolean
  description?: string
  differs: boolean
}
interface PresenceData {
  rows: PresenceRow[]
  columns: PresenceColumn[]
  warnings: string[]
}

const STATE_LABEL: Record<Exclude<PresenceColumn['state'], 'ok'>, string> = {
  'no-token': 'no token',
  unreachable: 'unreachable',
  'not-supported': 'older version'
}

/**
 * #1047 — which declared environment variables each API component has set.
 * Names and set / unset only; the server never sends a value. The warnings
 * ("set on staging, missing on production") show without opening the table:
 * they are the reason the panel exists.
 */
export function EnvPresencePanel() {
  const [open, setOpen] = useState(false)
  const { data, isFetching, error } = useQuery<PresenceData>({
    queryKey: ['environments-env-presence'],
    queryFn: () =>
      api.get<{ data: PresenceData }>('/environments/env-presence').then((r) => r.data.data),
    staleTime: 5 * 60_000,
    retry: false
  })
  // Nothing declared anywhere and nothing to warn about: no panel.
  if (data && data.rows.length === 0) return null
  const warnings = data?.warnings ?? []
  return (
    <div
      className='mb-5 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-env-presence
    >
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2 px-4 py-2.5 text-left'
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
        )}
        <span className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          Environment variables across environments
        </span>
        <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {isFetching && !data
            ? 'probing components…'
            : warnings.length > 0
              ? `${warnings.length} variable${warnings.length === 1 ? '' : 's'} set in one place, missing in another`
              : 'declared variables, set / unset only — never values'}
        </span>
      </button>

      {warnings.length > 0 && (
        <ul className='space-y-1 border-t border-slate-100 px-4 py-2.5 dark:border-border'>
          {warnings.map((w) => (
            <li
              key={w}
              className='flex items-start gap-2 text-[12px] text-amber-800 dark:text-amber-300'
              data-env-presence-warning
            >
              <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className='border-t border-slate-100 px-4 py-3 dark:border-border'>
          {error && (
            <p className='text-[12px] text-red-600'>
              {(error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                'Could not compare'}
            </p>
          )}
          {data && (
            <div className='overflow-x-auto'>
              <table className='w-full text-[12px]' data-env-presence-table>
                <thead>
                  <tr className='text-left text-[11px] text-slate-500 dark:text-muted-foreground'>
                    <th className='py-1.5 pr-3 font-medium'>Variable</th>
                    {data.columns.map((c) => (
                      <th key={String(c.id)} className='py-1.5 pr-3 font-medium'>
                        <span className='block text-slate-700 dark:text-slate-300'>{c.name}</span>
                        <span className='block text-[10.5px] font-normal'>
                          {c.environment ?? 'here'}
                          {c.state !== 'ok' && (
                            <span
                              className='ml-1 text-amber-700 dark:text-amber-300'
                              data-tip={c.note}
                            >
                              · {STATE_LABEL[c.state]}
                            </span>
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr
                      key={r.key}
                      className={cn(
                        'border-t border-slate-100 dark:border-border',
                        r.differs && 'bg-amber-50 dark:bg-amber-400/10'
                      )}
                      data-env-presence-row={r.key}
                      data-env-presence-differs={r.differs ? 'true' : undefined}
                    >
                      <td className='py-1.5 pr-3' data-tip={r.description}>
                        <span className='font-mono text-[11.5px] text-slate-800 dark:text-foreground'>
                          {r.name}
                        </span>
                        <span className='ml-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {r.extension}
                          {r.required ? ' · required' : ''}
                        </span>
                      </td>
                      {data.columns.map((c) => {
                        const v = c.state === 'ok' ? c.set[r.key] : undefined
                        return (
                          <td key={String(c.id)} className='py-1.5 pr-3'>
                            {v === true ? (
                              <span className='text-emerald-700 dark:text-emerald-400'>set</span>
                            ) : v === false ? (
                              <span
                                className={cn(
                                  r.required
                                    ? 'font-medium text-red-700 dark:text-red-400'
                                    : 'text-slate-500 dark:text-muted-foreground'
                                )}
                              >
                                unset
                              </span>
                            ) : (
                              <span className='text-slate-400'>·</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
