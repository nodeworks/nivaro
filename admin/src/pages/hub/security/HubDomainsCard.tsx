import { useQuery } from '@tanstack/react-query'
import { cn, formatDate } from '@/lib/utils'
import { SectionCard } from '../hub-parts'
import { type DomainRow, type EnvLabel, fetchCerts, securityKeys } from './security-api'
import { Chip } from './security-parts'

/**
 * Domains (Security tab, Task 34): every registrar domain the Hub manages, beside the TLS
 * certificates — when the registration ends, whether it renews by itself and whether the
 * transfer lock is on. Warned 45 and 14 days ahead (45 skipped when it renews by itself), and
 * when it has expired. Shares the certificates read (one request); shows nothing until a
 * registrar domain is managed.
 */

const th = 'px-3 py-2 text-left text-[11px] font-medium text-slate-500 dark:text-muted-foreground'
const td = 'px-3 py-2 align-top text-[12px] text-slate-700 dark:text-slate-200'

function domainWords(d: DomainRow): { tone: 'good' | 'warn' | 'bad'; text: string } {
  if (d.state === 'error')
    return {
      tone: 'bad',
      text: d.error_code === 'NO_EXPIRY' ? 'Registrar gave no date' : 'Could not read'
    }
  if (d.state === 'expired') return { tone: 'bad', text: 'Expired' }
  const left = d.days_left ?? 0
  return { tone: d.state === 'warning' ? 'warn' : 'good', text: `${left} days left` }
}

/** Who renews it: the Hub (switched on here), the registrar (read only at Namecheap), or by hand. */
function renewWords(d: DomainRow): string {
  if (d.hub_renew_days != null) return `Renewed by the Hub, ${d.hub_renew_days} days before`
  if (d.auto_renew == null) return '—'
  if (d.auto_renew) return d.renew_read_only ? 'Auto-renew at Namecheap (read only)' : 'By itself'
  return 'By hand'
}

function LockChip({ locked }: { locked: boolean | null }) {
  if (locked == null) return <span className='text-slate-400'>—</span>
  return locked ? <Chip tone='good'>Locked</Chip> : <Chip tone='warn'>Unlocked</Chip>
}

const appName = (envs: EnvLabel[], id: number | null) =>
  id == null ? 'Shared' : (envs.find((e) => e.app_id === id)?.app_name ?? `App ${id}`)

export default function HubDomainsCard() {
  const q = useQuery({ queryKey: securityKeys.certs(), queryFn: fetchCerts })
  const domains = q.data?.domains ?? []
  if (!domains.length) return null
  const envs = q.data?.environments ?? []
  const attention = domains.filter((d) => d.state !== 'ok' || d.locked === false).length
  return (
    <SectionCard
      title='Domains'
      description={
        attention
          ? `${attention} of ${domains.length} domains need attention. Owners are warned 45 and 14 days before a registration ends.`
          : `All ${domains.length} domains are registered for more than 45 days and locked against transfer.`
      }
    >
      <ul className='m-0 list-none divide-y divide-slate-100 p-0 md:hidden dark:divide-border'>
        {domains.map((d) => {
          const w = domainWords(d)
          return (
            <li key={d.id} className='px-4 py-3'>
              <div className='flex items-start justify-between gap-3'>
                <span className='min-w-0 break-all text-[13px] font-medium text-slate-900 dark:text-foreground'>
                  {d.domain}
                </span>
                <Chip tone={w.tone}>{w.text}</Chip>
              </div>
              <p className='m-0 mt-1 text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                {[
                  appName(envs, d.app_id),
                  d.expires_at ? `ends ${formatDate(d.expires_at)}` : null,
                  renewWords(d) === '—' ? null : renewWords(d),
                  d.locked === false ? 'transfer lock off' : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </li>
          )
        })}
      </ul>
      <div className='hidden overflow-x-auto md:block'>
        <table className='w-full min-w-[640px] border-collapse'>
          <thead className='border-b border-slate-200 dark:border-border'>
            <tr>
              <th className={th}>Domain</th>
              <th className={th}>App</th>
              <th className={th}>State</th>
              <th className={th}>Registered until</th>
              <th className={th}>Renews</th>
              <th className={th}>Transfer lock</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border'>
            {domains.map((d) => {
              const w = domainWords(d)
              return (
                <tr key={d.id}>
                  <td className={cn(td, 'font-medium text-slate-900 dark:text-foreground')}>
                    {d.domain}
                  </td>
                  <td className={td}>{appName(envs, d.app_id)}</td>
                  <td className={td}>
                    <Chip tone={w.tone}>{w.text}</Chip>
                  </td>
                  <td className={cn(td, 'tabular-nums')}>
                    {d.expires_at ? formatDate(d.expires_at) : '—'}
                  </td>
                  <td className={cn(td, 'text-slate-600 dark:text-muted-foreground')}>
                    {renewWords(d)}
                  </td>
                  <td className={td}>
                    <LockChip locked={d.locked} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}
