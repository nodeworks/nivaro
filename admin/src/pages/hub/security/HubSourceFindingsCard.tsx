import { useQuery } from '@tanstack/react-query'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { SectionCard } from '../hub-parts'
import { type EnvLabel, fetchVulns, securityKeys } from './security-api'
import { Chip } from './security-parts'
import {
  bySource,
  SEVERITY_WORD,
  type SourceRow,
  scanSummary,
  severityTone,
  sourceLabel,
  sourceRows,
  statusWords
} from './source-findings'

/**
 * Provider scans (Security tab, Task 33b): what the providers the Hub manages found — the newest
 * image of every managed Amazon ECR repository, a Snyk organisation's projects — beside the
 * scanner's findings for pinned images. Shares the vulnerabilities read (one request); shows
 * nothing until a source answers. Owners see their own apps' rows only (the API decides).
 */
export default function HubSourceFindingsCard() {
  const q = useQuery({ queryKey: securityKeys.vulns(), queryFn: fetchVulns })
  const rows = sourceRows(q.data)
  if (!rows.length) return null
  const envs = q.data?.environments ?? []
  const groups = bySource(rows)
  return (
    <SectionCard title='Provider scans' description={scanSummary(rows)}>
      <div className='divide-y divide-slate-100 dark:divide-border'>
        {groups.map((g) => (
          <section key={g.source} aria-label={sourceLabel(g.source)}>
            <h4 className='m-0 bg-slate-50/70 px-4 py-1.5 text-[11px] font-semibold text-slate-600 dark:bg-muted/30 dark:text-muted-foreground'>
              {sourceLabel(g.source)}
              <span className='ml-1.5 font-normal tabular-nums'>{g.rows.length}</span>
            </h4>
            <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
              {g.rows.map((r) => (
                <SourceLine key={r.key} row={r} envs={envs} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </SectionCard>
  )
}

/** "Orders · staging", "Orders", or "Shared" for a row with no app. */
export function whereWords(r: Pick<SourceRow, 'app_id' | 'environment_id'>, envs: EnvLabel[]) {
  const env =
    r.environment_id != null ? envs.find((e) => e.environment_id === r.environment_id) : null
  if (env) return `${env.app_name} · ${env.env_key}`
  if (r.app_id == null) return 'Shared'
  return envs.find((e) => e.app_id === r.app_id)?.app_name ?? `App ${r.app_id}`
}

function SourceLine({ row: r, envs }: { row: SourceRow; envs: EnvLabel[] }) {
  const status = statusWords(r.status)
  const meta = [whereWords(r, envs), r.detail, status].filter(Boolean).join(' · ')
  return (
    <li className='flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5'>
      <span className='min-w-0 flex-[1_1_300px]'>
        <span
          className={cn(
            'block truncate text-slate-900 dark:text-foreground',
            r.mono ? 'font-mono text-[12px]' : 'text-[12.5px] font-medium'
          )}
        >
          {r.name}
        </span>
        <span className='block break-words text-[11px] text-slate-500 sm:truncate dark:text-muted-foreground'>
          {meta}
          {r.at && (
            <span data-tip={formatDateTime(r.at)}>
              {meta ? ' · ' : ''}
              {r.atWord} {formatRelative(r.at)}
            </span>
          )}
        </span>
        {r.error && (
          <span className='mt-0.5 block text-[11px] text-red-700 dark:text-red-300'>
            Could not read: {r.error}
          </span>
        )}
      </span>
      <span className='flex flex-wrap items-center gap-1.5'>
        {r.counts == null ? (
          !r.error && <Chip tone='neutral'>No counts yet</Chip>
        ) : r.counts.length ? (
          r.counts.map((c) => (
            <Chip key={c.severity} tone={severityTone(c.severity)}>
              {c.n} {SEVERITY_WORD[c.severity] ?? c.severity}
            </Chip>
          ))
        ) : (
          <Chip tone='good'>No known findings</Chip>
        )}
        {r.fixable != null && r.fixable > 0 && <Chip tone='neutral'>{r.fixable} fixable</Chip>}
      </span>
    </li>
  )
}
