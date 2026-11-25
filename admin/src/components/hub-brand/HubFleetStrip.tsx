import { type DataTag, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ENV_TONE_LABEL, envTone } from './env-tone'
import { type HubHealth, HubStatusDot } from './HubBits'

/**
 * Always-visible fleet strip under the Hub top bar: one dot per environment, coloured by health,
 * grouped by app. ONE read (GET /api/hub/strip, the Hub's cached status), refreshed once a minute
 * while the tab is visible — never a request per dot. A dot opens its app on the Apps page.
 */

export interface FleetStripEntry {
  env_id: number
  env_key: string
  app_id: number
  app_key: string
  app_name: string
  state: 'ok' | 'degraded' | 'unreachable' | 'link_refused' | 'unknown'
  version: string | null
  checked_at: string | null
}

interface FleetStripAnswer {
  entries: FleetStripEntry[]
  truncated: boolean
}

export const fleetStripKey = () =>
  ['hub-fleet-strip'] as unknown as DataTag<readonly ['hub-fleet-strip'], FleetStripAnswer>

export function healthOf(state: FleetStripEntry['state']): HubHealth {
  if (state === 'ok') return 'ok'
  if (state === 'degraded' || state === 'link_refused') return 'warn'
  if (state === 'unreachable') return 'down'
  return 'unknown'
}

const HEALTH_WORDS: Record<HubHealth, string> = {
  ok: 'Running',
  warn: 'Needs a look',
  down: 'Not answering',
  unknown: 'Not checked yet'
}

/** Entries grouped by app, in the order the server sent them. */
export function groupByApp(entries: FleetStripEntry[]) {
  const groups: Array<{
    app_id: number
    app_key: string
    app_name: string
    envs: FleetStripEntry[]
  }> = []
  for (const e of entries) {
    const last = groups[groups.length - 1]
    if (last && last.app_id === e.app_id) last.envs.push(e)
    else groups.push({ app_id: e.app_id, app_key: e.app_key, app_name: e.app_name, envs: [e] })
  }
  return groups
}

export function HubFleetStrip() {
  const q = useQuery({
    queryKey: fleetStripKey(),
    queryFn: () => api.get<{ data: FleetStripAnswer }>('/hub/strip').then((r) => r.data.data),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false
  })
  const entries = q.data?.entries ?? []
  const counts = { ok: 0, warn: 0, down: 0, unknown: 0 }
  for (const e of entries) counts[healthOf(e.state)]++

  return (
    <div
      data-hub-fleet-strip=''
      className='flex h-9 shrink-0 items-center gap-3 border-b border-[var(--hub-chrome-line)] bg-[var(--hub-chrome-raised)] px-3 text-[11.5px] text-[var(--hub-chrome-muted)] sm:px-4'
    >
      <Link
        to='/hub'
        className='flex shrink-0 items-center gap-2 rounded font-medium text-[var(--hub-chrome-text)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
      >
        Fleet
        {q.data && <span className='sr-only'>: {summaryWords(counts)}</span>}
        {q.data && (
          <span aria-hidden className='hub-fact hidden items-center gap-2.5 tabular-nums sm:flex'>
            <span className='text-[var(--hub-ok-on-chrome)]'>{counts.ok} up</span>
            {counts.warn > 0 && (
              <span className='text-[var(--hub-warn-on-chrome)]'>{counts.warn} warn</span>
            )}
            {counts.down > 0 && (
              <span className='text-[var(--hub-down-on-chrome)]'>{counts.down} down</span>
            )}
          </span>
        )}
      </Link>
      <span aria-hidden className='h-4 w-px shrink-0 bg-[var(--hub-chrome-line)]' />
      {q.isPending ? (
        <span className='truncate'>Reading the fleet…</span>
      ) : q.isError ? (
        <span className='truncate'>The fleet could not be read just now.</span>
      ) : entries.length === 0 ? (
        <span className='truncate'>No environments yet.</span>
      ) : (
        <ul
          aria-label='Environments by app'
          className='m-0 flex min-w-0 flex-1 list-none items-center gap-4 overflow-x-auto p-0 [scrollbar-width:none]'
        >
          {groupByApp(entries).map((g) => (
            <li key={g.app_id} className='flex shrink-0 items-center gap-1.5'>
              <span className='hub-fact max-w-[10rem] truncate text-[var(--hub-chrome-text)]'>
                {g.app_key}
              </span>
              <span className='flex items-center gap-0.5'>
                {g.envs.map((e) => (
                  <FleetDot key={e.env_id} entry={e} />
                ))}
              </span>
            </li>
          ))}
          {q.data?.truncated && <li className='shrink-0'>and more</li>}
        </ul>
      )}
    </div>
  )
}

function FleetDot({ entry }: { entry: FleetStripEntry }) {
  const health = healthOf(entry.state)
  const tone = envTone(entry.env_key)
  const tip = `${entry.app_key} · ${entry.env_key} (${ENV_TONE_LABEL[tone].toLowerCase()}): ${HEALTH_WORDS[health]}${entry.version ? ` · ${entry.version}` : ''}`
  return (
    <Link
      to={`/hub?app=${entry.app_id}`}
      data-tip={tip}
      aria-label={tip}
      data-env-dot={tone}
      className={cn(
        'group flex h-6 items-center gap-1 rounded px-1 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
      )}
    >
      <HubStatusDot health={health} size={9} />
      <span
        aria-hidden
        className='hub-fact text-[10px] uppercase tracking-[0.04em]'
        style={{ color: `var(--hub-env-${tone}-ink-on-chrome, var(--hub-env-${tone}))` }}
      >
        {envAbbrev(entry.env_key)}
      </span>
    </Link>
  )
}

/** "production" → "prd", "staging" → "stg", anything else its first three letters. */
export function envAbbrev(key: string): string {
  const tone = envTone(key)
  const k = key.toLowerCase()
  if (tone === 'production' && /prod/.test(k)) return 'prd'
  if (tone === 'staging' && /stag/.test(k)) return 'stg'
  if (tone === 'development' && /^dev/.test(k)) return 'dev'
  return k.replace(/[^a-z0-9]/g, '').slice(0, 3) || key.slice(0, 3)
}

function summaryWords(c: Record<HubHealth, number>): string {
  const parts = [`${c.ok} running`]
  if (c.warn) parts.push(`${c.warn} need a look`)
  if (c.down) parts.push(`${c.down} not answering`)
  if (c.unknown) parts.push(`${c.unknown} not checked yet`)
  return parts.join(', ')
}
