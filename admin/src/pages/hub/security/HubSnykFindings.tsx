import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { cn, formatRelative } from '@/lib/utils'
import { SectionCard } from '../hub-parts'
import {
  fetchVulns,
  type SnykConnectionFindings,
  type SnykProject,
  securityKeys
} from './security-api'
import { Chip } from './security-parts'

/**
 * Snyk (Security → vulnerabilities, Task 43): what each Snyk connection's projects hold open, by
 * severity — read daily at 04:40 (and with an image Scan now), counts only. Snyk projects are repositories
 * and manifests, not image digests, so they are listed by connection and project, never mixed into
 * the image rows above. Hub administrators only (the API answers nothing to owners); shares the
 * vulnerabilities read; shows nothing until a Snyk connection exists.
 */

const th = 'px-3 py-2 text-left text-[11px] font-medium text-slate-500 dark:text-muted-foreground'
const thNum = cn(th, 'text-right')
const td = 'px-3 py-2 align-top text-[12px] text-slate-700 dark:text-slate-200'
const tdNum = cn(td, 'text-right tabular-nums')
/** Projects shown per connection before "Show all". */
const FIRST = 8

const open = (p: SnykProject) => p.critical + p.high + p.medium + p.low

function Count({ n, tone }: { n: number; tone: 'bad' | 'warn' | 'neutral' }) {
  if (!n) return <span className='text-slate-500 dark:text-muted-foreground'>0</span>
  return (
    <span
      className={cn(
        'font-medium',
        tone === 'bad' && 'text-red-700 dark:text-red-300',
        tone === 'warn' && 'text-amber-700 dark:text-amber-300'
      )}
    >
      {n}
    </span>
  )
}

function summary(c: SnykConnectionFindings): string {
  const t = c.totals
  if (!t) return c.ok ? 'Not read yet.' : 'Not read yet: the last read failed.'
  const parts = [
    `${t.projects} project${t.projects === 1 ? '' : 's'}`,
    t.critical || t.high ? `${t.critical} critical, ${t.high} high` : 'no critical or high issue',
    t.fixable != null && t.fixable > 0 ? `${t.fixable} fixable by an upgrade or patch` : null,
    t.unmonitored ? `${t.unmonitored} no longer monitored` : null
  ]
  return parts.filter(Boolean).join(' · ')
}

function ConnectionBlock({ c }: { c: SnykConnectionFindings }) {
  const [all, setAll] = useState(false)
  const withIssues = c.projects.filter((p) => open(p) > 0)
  const clean = c.projects.length - withIssues.length
  const shown = all ? withIssues : withIssues.slice(0, FIRST)
  return (
    <div className='border-t border-slate-100 first:border-t-0 dark:border-border'>
      <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pt-3'>
        <h4 className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {c.name}
        </h4>
        <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
          {c.read_at ? `Read ${formatRelative(c.read_at)}` : 'Never read'}
        </span>
      </div>
      <p className='m-0 px-4 pt-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
        {summary(c)}
      </p>
      {c.error ? (
        <p className='m-0 px-4 pt-1 text-[12px] text-amber-700 dark:text-amber-300'>
          The last read failed: {c.error.replace(/\.$/, '')}. The counts are from the read before.
        </p>
      ) : null}
      {withIssues.length ? (
        <>
          <ul className='m-0 mt-2 list-none divide-y divide-slate-100 p-0 md:hidden dark:divide-border'>
            {shown.map((p) => (
              <li key={p.id} className='px-4 py-2.5'>
                <div className='flex items-start justify-between gap-3'>
                  <span className='min-w-0 break-all text-[13px] text-slate-900 dark:text-foreground'>
                    {p.name ?? p.id}
                  </span>
                  {p.critical ? (
                    <Chip tone='bad'>{p.critical} critical</Chip>
                  ) : p.high ? (
                    <Chip tone='bad'>{p.high} high</Chip>
                  ) : (
                    <Chip tone='warn'>{open(p)} open</Chip>
                  )}
                </div>
                <p className='m-0 mt-1 text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                  {[
                    `${p.critical} critical · ${p.high} high · ${p.medium} medium · ${p.low} low`,
                    p.fixable ? `${p.fixable} fixable` : null,
                    p.monitored ? null : 'not monitored'
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
          <div className='mt-2 hidden overflow-x-auto md:block'>
            <table className='w-full min-w-[640px] border-collapse'>
              <thead className='border-b border-slate-200 dark:border-border'>
                <tr>
                  <th className={th}>Project</th>
                  <th className={thNum}>Critical</th>
                  <th className={thNum}>High</th>
                  <th className={thNum}>Medium</th>
                  <th className={thNum}>Low</th>
                  <th className={thNum}>Fixable</th>
                  <th className={th}>Monitored</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td
                      className={cn(
                        td,
                        'max-w-[360px] break-all text-slate-900 dark:text-foreground'
                      )}
                    >
                      {p.name ?? p.id}
                      {p.project_type ? (
                        <span className='ml-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {p.project_type}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdNum}>
                      <Count n={p.critical} tone='bad' />
                    </td>
                    <td className={tdNum}>
                      <Count n={p.high} tone='bad' />
                    </td>
                    <td className={tdNum}>
                      <Count n={p.medium} tone='warn' />
                    </td>
                    <td className={tdNum}>
                      <Count n={p.low} tone='neutral' />
                    </td>
                    <td className={tdNum}>{p.fixable == null ? '—' : p.fixable}</td>
                    <td className={td}>
                      {p.monitored ? 'Yes' : <Chip tone='warn'>No longer</Chip>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3 pt-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
        {withIssues.length > FIRST ? (
          <button
            type='button'
            className='rounded font-medium text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40'
            onClick={() => setAll(!all)}
          >
            {all ? 'Show fewer' : `Show all ${withIssues.length} with open issues`}
          </button>
        ) : null}
        {clean ? (
          <span>
            {clean} project{clean === 1 ? '' : 's'} with no open issue
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default function HubSnykFindings() {
  const q = useQuery({ queryKey: securityKeys.vulns(), queryFn: fetchVulns })
  const conns = q.data?.snyk ?? []
  if (!conns.length) return null
  const critical = conns.reduce((n, c) => n + (c.totals?.critical ?? 0), 0)
  const high = conns.reduce((n, c) => n + (c.totals?.high ?? 0), 0)
  return (
    <SectionCard
      title='Snyk'
      description={
        critical || high
          ? `${critical} critical and ${high} high open issues across the Snyk projects below. Read every night at 04:40.`
          : 'No critical or high open issue in any Snyk project. Read every night at 04:40.'
      }
    >
      {conns.map((c) => (
        <ConnectionBlock key={c.connection_id} c={c} />
      ))}
    </SectionCard>
  )
}
