import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Mail } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Monthly API usage for one key (#1462): calls by day and route family, error
 * rate, rate-limit refusals, GraphQL operations, CSV download, and the
 * opt-in monthly usage statement email. Reads GET /api-keys/:id/usage?month=.
 */

interface Bucket {
  calls: number
  errors: number
  rate_limited: number
  avg_ms: number | null
}
interface MonthlyUsage {
  month: string
  retention: { days: number; partial: boolean; note: string | null }
  totals: Bucket & { error_rate: number; refused: number; reads_ok: number; writes_ok: number }
  by_day: Array<Bucket & { day: string }>
  by_family: Array<Bucket & { family: string }>
  graphql: Array<{ operation: string; kind: string | null; calls: number; errors: number }>
  egress: { reads_ok: number; note: string }
}

function recentMonths(n: number): Array<{ value: string; label: string }> {
  const now = new Date()
  const out: Array<{ value: string; label: string }> = []
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    out.push({ value, label: i === 0 ? `${label} (so far)` : label })
  }
  return out
}

const fmt = (n: number) => n.toLocaleString()

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-400'>{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[15px] font-semibold tabular-nums text-slate-800 dark:text-slate-100',
          tone === 'bad' && 'text-red-600 dark:text-red-400',
          tone === 'warn' && 'text-amber-700 dark:text-amber-300'
        )}
      >
        {value}
      </p>
    </div>
  )
}

export function ApiKeyUsageSheet({
  keyId,
  keyName,
  usageStatement,
  usageContact,
  open,
  onOpenChange
}: {
  keyId: string | number
  keyName: string
  usageStatement: boolean
  usageContact: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const months = useMemo(() => recentMonths(3), [])
  const [month, setMonth] = useState(months[0].value)
  const [contact, setContact] = useState(usageContact ?? '')
  useEffect(() => setContact(usageContact ?? ''), [usageContact])

  const { data, isLoading, isError } = useQuery<MonthlyUsage>({
    queryKey: ['api-key-monthly-usage', keyId, month],
    queryFn: () =>
      api.get(`/api-keys/${keyId}/usage`, { params: { month } }).then((r) => r.data.data),
    enabled: open
  })

  const save = useMutation({
    mutationFn: (patch: { usage_statement?: boolean; usage_contact?: string | null }) =>
      api.patch(`/api-keys/${keyId}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] })
      toast.success('Saved')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error
      toast.error(msg ?? 'Could not save')
    }
  })

  const downloadCsv = () => {
    void api
      .get(`/api-keys/${keyId}/usage`, { params: { month, format: 'csv' }, responseType: 'blob' })
      .then((r) => {
        const url = URL.createObjectURL(r.data as Blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `usage-${keyName.replace(/[^A-Za-z0-9_-]+/g, '-')}-${month}.csv`
        a.click()
        URL.revokeObjectURL(url)
      })
  }

  const maxDay = data ? Math.max(1, ...data.by_day.map((d) => d.calls)) : 1

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        className='flex w-[640px] flex-col gap-0 overflow-y-auto p-0 sm:max-w-[640px]'
        data-key-usage-sheet
      >
        <SheetHeader className='border-b border-slate-200 px-5 py-4 dark:border-border'>
          <SheetTitle className='text-[14px]'>Usage · {keyName}</SheetTitle>
          <div className='flex flex-wrap items-center gap-2 pt-1'>
            <SimpleSelect
              value={month}
              onChange={setMonth}
              options={months}
              ariaLabel='Month'
              className='h-8 w-[200px] text-[12px]'
              triggerProps={{ 'data-key-usage-month': '' }}
            />
            <Button
              size='sm'
              variant='outline'
              className='h-8 gap-1.5 text-[12px]'
              onClick={downloadCsv}
              data-key-usage-csv
            >
              <Download className='h-3.5 w-3.5' />
              CSV
            </Button>
          </div>
        </SheetHeader>

        <div className='space-y-5 px-5 py-4'>
          {data?.retention.note && (
            <p
              data-key-usage-retention
              className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
            >
              {data.retention.note} Months before that cannot be reconstructed.
            </p>
          )}

          {isError ? (
            <p className='text-[12px] text-red-500'>Could not load usage for this month.</p>
          ) : isLoading || !data ? (
            <div className='h-40 animate-pulse rounded-lg bg-muted' />
          ) : (
            <>
              <div
                data-key-usage-totals
                className='grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'
              >
                <Stat label='Calls' value={fmt(data.totals.calls)} />
                <Stat
                  label='Error rate'
                  value={`${(data.totals.error_rate * 100).toFixed(1)}%`}
                  tone={data.totals.error_rate > 0.05 ? 'bad' : undefined}
                />
                <Stat
                  label='Rate-limited'
                  value={fmt(data.totals.rate_limited)}
                  tone={data.totals.rate_limited > 0 ? 'warn' : undefined}
                />
                <Stat label='Refused (401/403)' value={fmt(data.totals.refused)} />
                <Stat label='Successful reads' value={fmt(data.egress.reads_ok)} />
                <Stat label='Successful writes' value={fmt(data.totals.writes_ok)} />
              </div>
              <p className='-mt-3 text-[11px] text-slate-400'>{data.egress.note}</p>

              {data.totals.calls === 0 ? (
                <p className='text-[12px] text-slate-400'>
                  No calls by this key that the request log still holds for this month.
                </p>
              ) : (
                <>
                  <section>
                    <h3 className='mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                      Calls by day <span className='normal-case text-red-400'>(errors in red)</span>
                    </h3>
                    <div className='flex h-20 items-end gap-[2px] rounded-lg border border-slate-200 bg-white p-2 dark:border-border dark:bg-card'>
                      {data.by_day.map((d) => (
                        <div
                          key={d.day}
                          data-tip={`${d.day}: ${fmt(d.calls)} calls, ${fmt(d.errors)} errors, ${fmt(d.rate_limited)} rate-limited`}
                          className='flex flex-1 flex-col justify-end self-stretch'
                        >
                          <div
                            className='flex w-full flex-col justify-end overflow-hidden rounded-sm bg-nvr-cyan/40'
                            style={{ height: `${Math.max(3, (d.calls / maxDay) * 100)}%` }}
                          >
                            {d.errors > 0 && (
                              <div
                                className='w-full bg-red-500'
                                style={{ height: `${Math.max(8, (d.errors / d.calls) * 100)}%` }}
                              />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <UsageTable
                    title='By route family'
                    rows={data.by_family.map((f) => ({ label: f.family, ...f }))}
                    attr='data-key-usage-family'
                  />

                  {data.graphql.length > 0 && (
                    <UsageTable
                      title='GraphQL operations'
                      rows={data.graphql.map((g) => ({
                        label: g.kind ? `${g.kind} ${g.operation}` : g.operation,
                        calls: g.calls,
                        errors: g.errors,
                        rate_limited: null,
                        avg_ms: null
                      }))}
                      attr='data-key-usage-graphql'
                    />
                  )}
                </>
              )}
            </>
          )}

          <section
            data-key-usage-statement
            className='space-y-2 rounded-lg border border-slate-200 p-3 dark:border-border'
          >
            <div className='flex items-center justify-between gap-3'>
              <div>
                <p className='flex items-center gap-1.5 text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
                  <Mail className='h-3.5 w-3.5 text-nvr-cyan' />
                  Monthly usage statement
                </p>
                <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
                  On the 1st, last month’s figures are emailed to the contact below (or the key’s
                  owner when it is blank).
                </p>
              </div>
              <Switch
                checked={usageStatement}
                disabled={save.isPending}
                onCheckedChange={(v) => save.mutate({ usage_statement: v === true })}
                data-key-usage-statement-toggle
                aria-label='Send the monthly usage statement'
              />
            </div>
            <div className='flex items-center gap-2'>
              <Input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder='partner-team@example.com'
                className='h-8 text-[12px]'
                data-key-usage-contact
              />
              <Button
                size='sm'
                variant='outline'
                className='h-8 text-[12px]'
                disabled={save.isPending || contact.trim() === (usageContact ?? '')}
                onClick={() => save.mutate({ usage_contact: contact.trim() || null })}
              >
                Save contact
              </Button>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function UsageTable({
  title,
  rows,
  attr
}: {
  title: string
  rows: Array<{
    label: string
    calls: number
    errors: number
    rate_limited: number | null
    avg_ms: number | null
  }>
  attr: string
}) {
  return (
    <section>
      <h3 className='mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
        {title}
      </h3>
      <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
        <table className='w-full bg-white text-[12px] tabular-nums dark:bg-card'>
          <thead>
            <tr className='border-b border-slate-200 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:border-border'>
              <th className='px-3 py-1.5'>Name</th>
              <th className='px-3 py-1.5 text-right'>Calls</th>
              <th className='px-3 py-1.5 text-right'>Errors</th>
              <th className='px-3 py-1.5 text-right'>Rate-limited</th>
              <th className='px-3 py-1.5 text-right'>Avg ms</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.label}
                {...{ [attr]: r.label }}
                className='border-b border-slate-100 last:border-0 dark:border-border/50'
              >
                <td className='px-3 py-1.5'>
                  <code className='font-mono text-[11px] text-slate-600 dark:text-slate-300'>
                    {r.label}
                  </code>
                </td>
                <td className='px-3 py-1.5 text-right'>{fmt(r.calls)}</td>
                <td
                  className={cn(
                    'px-3 py-1.5 text-right',
                    r.errors > 0 ? 'text-red-500' : 'text-slate-400'
                  )}
                >
                  {fmt(r.errors)}
                </td>
                <td className='px-3 py-1.5 text-right text-slate-500'>
                  {r.rate_limited == null ? '—' : fmt(r.rate_limited)}
                </td>
                <td className='px-3 py-1.5 text-right text-slate-500'>{r.avg_ms ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
