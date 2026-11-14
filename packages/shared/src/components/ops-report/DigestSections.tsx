import type { OpsDigest, OpsReport } from '../../lib/ops-report-types'
import { cn } from '../../lib/utils'
import { Drillable, useDrill } from './drill'
import { arr, dr, formatKpi, ms, num } from './format'
import { type Col, MiniTable, Section, Stat, SubTitle } from './ui'

const mono = 'font-mono text-[11.5px]'

/** Every digest block as a collapsible section. A block an older report lacks reads "Nothing recorded". */
export function DigestSections({ report }: { report: OpsReport }) {
  const d: Partial<OpsDigest> = report.digest ?? {}
  const traffic = d.traffic
  const speed = d.speed
  const errors = d.errors
  const db = d.database
  const issues = d.issues
  const jobs = d.jobs
  const integ = d.integrations
  const mail = d.mail
  const work = d.work
  const search = d.search
  const sec = d.security
  const cap = d.capacity
  const watch = d.watch
  const hours = arr(traffic?.by_hour)
  const maxReq = Math.max(1, ...hours.map((h) => h.requests))
  const deploys = arr(d.deploys)
  const drains = arr(d.drains)
  const imports = arr(d.imports)
  const notifs = arr(d.notifications)
  const cfg = arr(d.config_changes)
  const sections = arr(d.sections)
  const drill = useDrill()

  const backlogTotal = arr(work?.backlog).reduce((a, b) => a + b.waiting, 0)
  const mailSent = arr(mail?.by_status).find((s) => s.status === 'sent')?.n
  const mailFailed = arr(mail?.by_status)
    .filter((s) => s.status !== 'sent')
    .reduce((a, b) => a + b.n, 0)

  return (
    <div className='space-y-1.5' data-ops-sections=''>
      <Section
        id='traffic'
        title='Traffic'
        empty={!traffic}
        gist={`${num(traffic?.requests)} requests · ${num(traffic?.page_views)} page views${
          traffic?.peak ? ` · peak ${hourLabel(traffic.peak.hour)}` : ''
        }`}
      >
        {hours.length > 0 && (
          <div>
            <SubTitle>Requests by hour</SubTitle>
            <div className='flex h-20 items-end gap-1' role='img' aria-label='Requests by hour'>
              {hours.map((h) => (
                <Drillable
                  key={h.hour}
                  target={dr('requests_by_hour', h.hour, hourLabel(h.hour))}
                  tip={`${hourLabel(h.hour)} · ${num(h.requests)} requests · ${num(h.people)} people${
                    h.e5 ? ` · ${h.e5} server errors` : ''
                  }`}
                  className='group flex h-full min-w-0 flex-1 flex-col justify-end'
                >
                  <div
                    className={cn(
                      'w-full rounded-t-sm',
                      h.e5 > 0 ? 'bg-red-500' : 'bg-nvr-cyan/70 group-hover:bg-nvr-cyan'
                    )}
                    style={{ height: `${Math.max(3, (h.requests / maxReq) * 100)}%` }}
                  />
                </Drillable>
              ))}
            </div>
            <div className='mt-1 flex gap-1 text-[10px] text-slate-500 dark:text-muted-foreground'>
              {hours.map((h) => (
                <span key={h.hour} className='min-w-0 flex-1 text-center tabular-nums'>
                  {hourShort(h.hour)}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat label='Requests' value={num(traffic?.requests)} drill={dr('requests')} />
          <Stat label='Page views' value={num(traffic?.page_views)} drill={dr('page_views')} />
          {traffic?.peak && (
            <Stat
              label={`Peak at ${hourLabel(traffic.peak.hour)}`}
              value={`${num(traffic.peak.requests)} req`}
              drill={dr('requests_by_hour', traffic.peak.hour)}
            />
          )}
        </div>
      </Section>

      <Section
        id='speed'
        title='Speed'
        empty={!speed}
        gist={`p95 ${ms(speed?.p95)} · p99 ${ms(speed?.p99)} · ${num(speed?.over5s)} over 5 s`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat label='Average' value={ms(speed?.avg_ms)} drill={dr('over5s')} />
          <Stat label='Median' value={ms(speed?.p50)} drill={dr('over5s')} />
          <Stat label='p90' value={ms(speed?.p90)} drill={dr('over5s')} />
          <Stat label='p95' value={ms(speed?.p95)} drill={dr('over5s')} />
          <Stat label='p99' value={ms(speed?.p99)} drill={dr('over5s')} />
          <Stat label='Over 1 s' value={num(speed?.over1s)} drill={dr('over5s', '1s')} />
          <Stat label='Over 5 s' value={num(speed?.over5s)} drill={dr('over5s')} />
          <Stat
            label='Over 30 s'
            value={num(speed?.over30s)}
            tone={speed?.over30s ? 'bad' : undefined}
            drill={dr('over5s', '30s')}
          />
        </div>
        <MiniTable
          title='Bursts of slow calls'
          rows={arr(speed?.bursts)}
          drill={(r) => dr('burst', r.route, r.route)}
          cols={[
            { h: 'At', cell: (r) => r.at },
            { h: 'Route', cell: (r) => r.route },
            { h: 'Calls', cell: (r) => num(r.n), num: true },
            { h: 'People', cell: (r) => num(r.people), num: true },
            { h: 'Slowest', cell: (r) => ms(r.max_ms), num: true }
          ]}
        />
        <MiniTable
          title='Slowest routes'
          rows={arr(speed?.slow_routes)}
          drill={(r) => dr('slow_route', r.route, r.route)}
          cols={[
            { h: 'Route', cell: (r) => r.route, className: mono },
            { h: 'Calls', cell: (r) => num(r.n), num: true },
            { h: 'Average', cell: (r) => ms(r.avg_ms), num: true },
            { h: 'Slowest', cell: (r) => ms(r.max_ms), num: true },
            { h: 'People', cell: (r) => num(r.people), num: true }
          ]}
        />
        <MiniTable
          title='Most server time'
          rows={arr(speed?.heavy_routes)}
          drill={(r) => dr('slow_route', r.route, r.route)}
          cols={[
            { h: 'Route', cell: (r) => r.route, className: mono },
            { h: 'Total', cell: (r) => `${num(r.total_s)} s`, num: true },
            { h: 'Calls', cell: (r) => num(r.n), num: true },
            { h: 'Average', cell: (r) => ms(r.avg_ms), num: true }
          ]}
        />
      </Section>

      <Section
        id='errors'
        title='Errors'
        empty={!errors}
        gist={`${num(errors?.server_total)} server · ${num(errors?.drain_503)} deploy-drain 503s · ${num(errors?.signed_out_401)} signed-out 401s`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat
            label='Server errors'
            value={num(errors?.server_total)}
            drill={dr('server_errors')}
          />
          <Stat
            label='Deploy-drain 503s'
            value={num(errors?.drain_503)}
            drill={dr('server_errors', '503')}
          />
          <Stat
            label='Signed-out 401s'
            value={num(errors?.signed_out_401)}
            drill={dr('client_errors', '401')}
          />
        </div>
        <MiniTable
          title='Server errors'
          rows={arr(errors?.server)}
          drill={(r) => dr('server_errors', r.route, r.route)}
          cols={[
            { h: 'At', cell: (r) => r.at },
            { h: 'Status', cell: (r) => r.status, num: true },
            { h: 'Route', cell: (r) => r.route, className: mono },
            { h: 'Took', cell: (r) => ms(r.ms), num: true },
            { h: 'Person', cell: (r) => r.person ?? 'No one signed in' }
          ]}
        />
        <MiniTable
          title='Refused requests (4xx)'
          rows={arr(errors?.client_by_route)}
          drill={(r) => dr('client_errors', r.route, r.route)}
          cols={[
            { h: 'Status', cell: (r) => r.status, num: true },
            { h: 'Route', cell: (r) => r.route, className: mono },
            { h: 'Calls', cell: (r) => num(r.n), num: true },
            { h: 'People', cell: (r) => num(r.people), num: true },
            { h: 'Said', cell: (r) => r.message }
          ]}
        />
      </Section>

      <Section
        id='deploys'
        title='Deploys and drains'
        empty={!deploys.length && !drains.length}
        gist={`${deploys.length} deploys · ${drains.length} drains`}
      >
        <MiniTable
          title='Deploys'
          rows={deploys}
          drill={(r) => dr('deploys', r.version, r.version ?? r.at)}
          limit={30}
          cols={[
            { h: 'At', cell: (r) => r.at },
            { h: 'Version', cell: (r) => r.version ?? '–', className: mono },
            { h: 'Release', cell: (r) => r.release ?? '' }
          ]}
        />
        <MiniTable
          title='Drains (requests answered 503)'
          rows={drains}
          drill={(r) => dr('deploys', r.at, r.at)}
          cols={[
            { h: 'At', cell: (r) => r.at },
            { h: 'Requests', cell: (r) => num(r.n), num: true }
          ]}
        />
      </Section>

      <Section
        id='database'
        title='Database'
        empty={!db}
        gist={`${arr(db?.deadlocks).length} deadlocks · ${arr(db?.timeouts).length} timeouts · ${arr(db?.freezes).length} freezes`}
      >
        <MiniTable
          title='Deadlocks'
          rows={arr(db?.deadlocks)}
          drill={(r) => dr('issue', r.issue, `Issue #${r.issue}`)}
          cols={[
            { h: 'Issue', cell: (r) => `#${r.issue}`, num: true },
            { h: 'At', cell: (r) => r.at },
            { h: 'Victim', cell: (r) => r.victim, className: mono },
            { h: 'Other side', cell: (r) => r.other, className: mono }
          ]}
        />
        <MiniTable
          title='Timeouts'
          rows={arr(db?.timeouts)}
          drill={(r) => dr('issue', r.issue, `Issue #${r.issue}`)}
          cols={[
            { h: 'Issue', cell: (r) => `#${r.issue}`, num: true },
            { h: 'What', cell: (r) => r.title }
          ]}
        />
        <MiniTable
          title='Freezes'
          rows={arr(db?.freezes)}
          drill={(r) => dr('issue', r.issue, `Issue #${r.issue}`)}
          cols={[
            { h: 'Issue', cell: (r) => `#${r.issue}`, num: true },
            { h: 'What', cell: (r) => r.title },
            { h: 'Likely cause', cell: (r) => r.cause ?? '—' }
          ]}
        />
      </Section>

      <Section
        id='issues'
        title='Issues'
        empty={!arr(issues?.new).length && !arr(issues?.repeating).length}
        gist={`${arr(issues?.new).length} new · ${arr(issues?.repeating).length} repeating`}
      >
        <MiniTable
          title='New today'
          rows={arr(issues?.new)}
          drill={(r) => dr('issue', r.id, `Issue #${r.id}`)}
          cols={[
            { h: 'Issue', cell: (r) => `#${r.id}`, num: true },
            { h: 'Source', cell: (r) => r.source },
            { h: 'Severity', cell: (r) => r.severity },
            { h: 'Title', cell: (r) => r.title },
            { h: 'Seen', cell: (r) => num(r.count), num: true }
          ]}
        />
        <MiniTable
          title='Repeating'
          rows={arr(issues?.repeating)}
          drill={(r) => dr('issue', r.id, `Issue #${r.id}`)}
          cols={[
            { h: 'Issue', cell: (r) => `#${r.id}`, num: true },
            { h: 'Title', cell: (r) => r.title },
            { h: 'Seen', cell: (r) => num(r.count), num: true }
          ]}
        />
      </Section>

      <Section
        id='jobs'
        title='Jobs'
        empty={!jobs}
        gist={`${num(jobs?.runs)} runs · ${arr(jobs?.failed).length} failed`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat label='Runs' value={num(jobs?.runs)} drill={dr('job')} />
          <Stat label='Failed' value={num(arr(jobs?.failed).length)} drill={dr('job_failures')} />
        </div>
        <MiniTable
          title='Failed'
          rows={arr(jobs?.failed)}
          drill={(r) => dr('job', r.job, r.job)}
          cols={[
            { h: 'Job', cell: (r) => r.job, className: mono },
            { h: 'At', cell: (r) => r.at },
            { h: 'Status', cell: (r) => r.status },
            { h: 'Said', cell: (r) => r.error ?? '' }
          ]}
        />
        <MiniTable
          title='Slowest'
          rows={arr(jobs?.slowest)}
          drill={(r) => dr('job', r.job, r.job)}
          cols={[
            { h: 'Job', cell: (r) => r.job, className: mono },
            { h: 'Runs', cell: (r) => num(r.n), num: true },
            { h: 'Average', cell: (r) => ms(r.avg_ms), num: true },
            { h: 'Slowest', cell: (r) => ms(r.max_ms), num: true }
          ]}
        />
      </Section>

      <Section
        id='integrations'
        title='Partner integrations'
        empty={
          !arr(integ?.calls).length &&
          !arr(integ?.submissions).length &&
          !arr(integ?.failures).length &&
          !arr(integ?.alerts).length
        }
        gist={`${arr(integ?.calls).length} partners called · ${arr(integ?.failures).length} sends failed · ${arr(integ?.open_alarms).length} open alarms`}
      >
        <MiniTable
          title='Partner response time vs the 7-day average'
          rows={arr(integ?.calls)}
          drill={(r) => dr('integration_calls', r.api, r.api)}
          cols={[
            { h: 'Partner', cell: (r) => r.api },
            { h: 'Calls', cell: (r) => num(r.n), num: true },
            { h: 'Failed', cell: (r) => num(r.failed), num: true },
            { h: 'Average', cell: (r) => ms(r.avg_ms), num: true },
            { h: '7-day avg', cell: (r) => ms(r.week_avg_ms), num: true },
            {
              h: 'Slowest',
              cell: (r) => ms(r.max_ms),
              num: true
            },
            {
              h: 'Vs usual',
              num: true,
              cell: (r) => {
                if (!r.week_avg_ms) return '–'
                const pct = ((r.avg_ms - r.week_avg_ms) / r.week_avg_ms) * 100
                if (Math.abs(pct) < 5) return 'same'
                return (
                  <span
                    className={
                      pct > 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                    }
                  >
                    {pct > 0 ? '+' : '−'}
                    {Math.round(Math.abs(pct))}%
                  </span>
                )
              }
            }
          ]}
        />
        <MiniTable
          title='Submissions'
          rows={arr(integ?.submissions)}
          drill={(r) => dr('integration_failures', r.api, r.api)}
          cols={[
            { h: 'Partner', cell: (r) => r.api },
            { h: 'Status', cell: (r) => r.status },
            { h: 'Sends', cell: (r) => num(r.n), num: true }
          ]}
        />
        <MiniTable
          title='Failed sends'
          rows={arr(integ?.failures)}
          drill={(r) => dr('integration_failures', r.api, r.api)}
          cols={[
            { h: 'At', cell: (r) => r.at },
            { h: 'Partner', cell: (r) => r.api },
            { h: 'Record', cell: (r) => `${r.collection} ${r.item}`, className: mono },
            { h: 'Said', cell: (r) => r.error }
          ]}
        />
        <MiniTable
          title='Open alarms'
          rows={arr(integ?.open_alarms)}
          drill={(r) => dr('open_alarms', r.api, r.api)}
          cols={[
            { h: 'Partner', cell: (r) => r.api },
            { h: 'Kind', cell: (r) => r.kind },
            { h: 'Outcome', cell: (r) => r.outcome },
            { h: 'Count', cell: (r) => num(r.n), num: true }
          ]}
        />
        <MiniTable
          title='Alerts'
          rows={arr(integ?.alerts)}
          drill={(r) => dr('open_alarms', r.title, r.title)}
          cols={[
            { h: 'Alert', cell: (r) => r.title },
            { h: 'Status', cell: (r) => r.status },
            { h: 'Started', cell: (r) => r.started },
            { h: 'Ended', cell: (r) => r.ended ?? 'still open' }
          ]}
        />
      </Section>

      <Section
        id='imports'
        title='Imports'
        empty={!imports.length}
        gist={`${imports.length} definitions ran · ${num(imports.reduce((a, b) => a + b.rows, 0))} rows`}
      >
        <MiniTable
          rows={imports}
          drill={(r) => dr('imports', r.definition, r.definition)}
          cols={[
            { h: 'Import', cell: (r) => r.definition, className: mono },
            { h: 'Status', cell: (r) => r.status },
            { h: 'Runs', cell: (r) => num(r.runs), num: true },
            { h: 'Rows', cell: (r) => num(r.rows), num: true }
          ]}
        />
      </Section>

      <Section
        id='mail'
        title='Mail'
        empty={!arr(mail?.by_status).length}
        gist={`${num(mailSent)} sent · ${num(mailFailed)} not sent`}
      >
        <MiniTable
          rows={arr(mail?.by_status)}
          drill={(r) => dr('mail', r.status, r.status)}
          cols={[
            { h: 'Status', cell: (r) => r.status },
            { h: 'Mails', cell: (r) => num(r.n), num: true }
          ]}
        />
        <MiniTable
          title='Why mail did not go'
          rows={arr(mail?.reasons)}
          drill={(r) => dr('mail', r.reason, r.reason)}
          cols={[
            { h: 'Reason', cell: (r) => r.reason },
            { h: 'Mails', cell: (r) => num(r.n), num: true }
          ]}
        />
      </Section>

      <Section
        id='notifications'
        title='Notifications'
        empty={!notifs.length}
        gist={`${num(notifs.reduce((a, b) => a + b.n, 0))} sent`}
      >
        <MiniTable
          rows={notifs}
          drill={(r) => dr('notifications', r.category, r.category)}
          cols={[
            { h: 'Category', cell: (r) => r.category },
            { h: 'Sent', cell: (r) => num(r.n), num: true },
            { h: 'People', cell: (r) => num(r.recipients), num: true },
            { h: 'Read', cell: (r) => num(r.read), num: true }
          ]}
        />
      </Section>

      <Section
        id='work'
        title='Work and backlog'
        empty={!work}
        gist={`${num(work?.moves)} moves by ${num(work?.movers)} people · ${num(backlogTotal)} waiting · ${arr(work?.sla_breaches).reduce((a, b) => a + b.breached, 0)} past deadline`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat label='Moves' value={num(work?.moves)} drill={dr('moves')} />
          <Stat label='People moving work' value={num(work?.movers)} drill={dr('moves')} />
          <Stat label='Waiting now' value={num(backlogTotal)} drill={dr('backlog')} />
        </div>
        <MiniTable
          title='Moves by state'
          rows={arr(work?.by_state)}
          drill={(r) => dr('moves', r.state, r.state)}
          cols={[
            { h: 'State', cell: (r) => r.state },
            { h: 'Moves', cell: (r) => num(r.n), num: true }
          ]}
        />
        <MiniTable
          title='Records created'
          rows={arr(work?.creates)}
          drill={(r) => dr('creates', r.collection, r.collection)}
          cols={[
            { h: 'Collection', cell: (r) => r.collection, className: mono },
            { h: 'Created', cell: (r) => num(r.n), num: true },
            { h: 'People', cell: (r) => num(r.people), num: true }
          ]}
        />
        <MiniTable
          title='Waiting now'
          rows={arr(work?.backlog)}
          drill={(r) => dr('backlog', r.state, r.state)}
          cols={[
            { h: 'State', cell: (r) => r.state },
            { h: 'Waiting', cell: (r) => num(r.waiting), num: true },
            {
              h: 'Oldest',
              cell: (r) => (r.oldest_days == null ? '–' : `${r.oldest_days} days`),
              num: true
            }
          ]}
        />
        <MiniTable
          title='Past deadline'
          rows={arr(work?.sla_breaches)}
          drill={(r) => dr('sla_breaches', r.rule, r.rule)}
          cols={[
            { h: 'Rule', cell: (r) => r.rule },
            { h: 'Collection', cell: (r) => r.collection, className: mono },
            { h: 'Breached', cell: (r) => num(r.breached), num: true }
          ]}
        />
      </Section>

      <Section
        id='search'
        title='Search'
        empty={!search}
        gist={`${num(search?.n)} searches · ${num(search?.zero)} found nothing · ${ms(search?.avg_ms)} average`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat label='Searches' value={num(search?.n)} drill={dr('searches')} />
          <Stat label='People searching' value={num(search?.people)} drill={dr('searches')} />
          <Stat label='Found nothing' value={num(search?.zero)} drill={dr('search_zero')} />
        </div>
        <MiniTable
          title='Searches that found nothing'
          rows={arr(search?.missed)}
          drill={(r) => dr('search_zero', r.query, r.query)}
          cols={[
            { h: 'Query', cell: (r) => r.query },
            { h: 'Times', cell: (r) => num(r.n), num: true }
          ]}
        />
      </Section>

      <Section
        id='config'
        title='Config changes'
        empty={!cfg.length}
        gist={`${cfg.length} changes`}
      >
        <MiniTable
          rows={cfg}
          drill={(r) => dr('config_changes', r.collection, r.collection)}
          limit={30}
          cols={[
            { h: 'At', cell: (r) => r.at },
            { h: 'Who', cell: (r) => r.who ?? 'System' },
            { h: 'Action', cell: (r) => r.action },
            {
              h: 'What',
              cell: (r) => `${r.collection}${r.item ? ` ${r.item}` : ''}`,
              className: mono
            }
          ]}
        />
      </Section>

      <Section
        id='security'
        title='Security'
        empty={!sec}
        gist={`${num(sec?.new_places)} new places · ${num(sec?.failed_sign_ins)} failed sign-ins · ${arr(sec?.view_as).length} View-as`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat label='New places' value={num(sec?.new_places)} drill={dr('new_places')} />
          <Stat
            label='Failed sign-ins'
            value={num(sec?.failed_sign_ins)}
            drill={dr('failed_sign_ins')}
          />
          <Stat label='Access granted' value={num(sec?.access_grants)} drill={dr('access')} />
          <Stat label='Access requests' value={num(sec?.access_requests)} drill={dr('access')} />
          <Stat
            label='Waiting for authorization'
            value={num(sec?.waiting_authorization)}
            drill={dr('access')}
          />
        </div>
        <MiniTable
          title='View-as'
          rows={arr(sec?.view_as)}
          drill={(r) => dr('view_as_sessions', r.who, r.who ?? 'View-as')}
          cols={[
            { h: 'Who', cell: (r) => r.who ?? 'Unknown' },
            { h: 'At', cell: (r) => r.at }
          ]}
        />
        <MiniTable
          title='Role changes'
          rows={arr(sec?.role_changes)}
          drill={(r) => dr('role_changes', r.person, r.person ?? 'Role change')}
          cols={[
            { h: 'At', cell: (r) => r.at },
            { h: 'By', cell: (r) => r.who ?? 'System' },
            { h: 'Person', cell: (r) => r.person ?? 'Unknown' }
          ]}
        />
        <MiniTable
          title='API key use'
          rows={arr(sec?.api_key_use)}
          drill={(r) => dr('api_key_use', r.name, r.name)}
          cols={[
            { h: 'Key', cell: (r) => r.name },
            { h: 'Requests', cell: (r) => num(r.requests), num: true }
          ]}
        />
      </Section>

      <Section
        id='capacity'
        title='Capacity'
        empty={!cap}
        gist={`${cap?.memory_mb != null ? `${num(cap.memory_mb)} MB memory · ` : ''}${arr(cap?.restarts).length} restarts`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          {cap?.pool && (
            <>
              <Stat
                label='Request connections'
                value={num(cap.pool.main_max)}
                drill={dr('capacity')}
              />
              <Stat
                label='Background connections'
                value={num(cap.pool.background_max)}
                drill={dr('capacity')}
              />
            </>
          )}
          {cap?.memory_mb != null && (
            <Stat label='Memory' value={`${num(cap.memory_mb)} MB`} drill={dr('capacity')} />
          )}
          {cap?.backups && (
            <>
              <Stat
                label={`Last full backup (${cap.backups.last_full ?? 'unknown'})`}
                value={
                  cap.backups.last_full_age_hours == null
                    ? '–'
                    : `${num(cap.backups.last_full_age_hours, 1)} h ago`
                }
                drill={dr('capacity')}
              />
              <Stat
                label={`Last log backup (${cap.backups.last_log ?? 'unknown'})`}
                value={
                  cap.backups.last_log_age_hours == null
                    ? '–'
                    : `${num(cap.backups.last_log_age_hours, 1)} h ago`
                }
                drill={dr('capacity')}
              />
            </>
          )}
        </div>
        <MiniTable
          title='Disk'
          rows={arr(cap?.disk)}
          drill={() => dr('capacity')}
          cols={[
            { h: 'Path', cell: (r) => r.path, className: mono },
            { h: 'Free', cell: (r) => `${num(r.free_pct)}%`, num: true },
            { h: 'Free space', cell: (r) => `${num(r.free_gb)} GB`, num: true }
          ]}
        />
        <MiniTable
          title='Restarts'
          rows={arr(cap?.restarts)}
          drill={() => dr('deploys')}
          cols={[
            { h: 'At', cell: (r) => r.at },
            { h: 'What', cell: (r) => r.what }
          ]}
        />
      </Section>

      <Section
        id='watch'
        title='Watch list for tomorrow'
        empty={
          !arr(watch?.jobs_next).length &&
          !arr(watch?.pending_sends).length &&
          !arr(watch?.expiring).length
        }
        gist={`${arr(watch?.jobs_next).length} jobs · ${arr(watch?.pending_sends).length} pending sends · ${arr(watch?.expiring).length} expiring`}
      >
        <MiniTable
          title='Jobs coming up'
          rows={arr(watch?.jobs_next)}
          drill={(r) => dr('job', r.job, r.job)}
          cols={[
            { h: 'Job', cell: (r) => r.job, className: mono },
            { h: 'At', cell: (r) => r.at },
            { h: 'Heavy', cell: (r) => (r.heavy ? 'yes' : '') }
          ]}
        />
        <MiniTable
          title='Sends still waiting'
          rows={arr(watch?.pending_sends)}
          drill={(r) => dr('pending_sends', r.api, r.api)}
          cols={[
            { h: 'Partner', cell: (r) => r.api },
            { h: 'Waiting', cell: (r) => num(r.n), num: true },
            { h: 'Oldest', cell: (r) => r.oldest ?? '–' }
          ]}
        />
        <MiniTable
          title='Expiring'
          rows={arr(watch?.expiring)}
          drill={() => dr('expiring')}
          cols={[
            { h: 'What', cell: (r) => r.what.replace('_', ' ') },
            { h: 'Name', cell: (r) => r.name },
            { h: 'Expires', cell: (r) => r.expires },
            { h: 'In', cell: (r) => `${r.days} days`, num: true }
          ]}
        />
      </Section>

      <Section
        id='pages'
        title='Screens people opened'
        empty={!d.pages}
        gist={`${num(d.pages?.views)} views · ${num(d.pages?.people)} people`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat label='Page views' value={num(d.pages?.views)} drill={dr('page_views')} />
          <Stat label='People' value={num(d.pages?.people)} drill={dr('page_views')} />
        </div>
        <MiniTable
          title='Top screens'
          rows={arr(d.pages?.top)}
          drill={(r) => dr('page_views', r.page, r.page)}
          cols={[
            { h: 'Screen', cell: (r) => r.page, className: mono },
            { h: 'Views', cell: (r) => num(r.views), num: true },
            { h: 'People', cell: (r) => num(r.people), num: true },
            {
              h: 'Time on screen',
              cell: (r) => (r.avg_seconds == null ? '–' : `${num(r.avg_seconds)} s`),
              num: true
            },
            { h: '7-day avg views', cell: (r) => num(r.week_avg_views), num: true }
          ]}
        />
      </Section>

      <Section
        id='browser-errors'
        title='Browser errors'
        empty={!arr(d.client_errors).length}
        gist={`${arr(d.client_errors).length} kinds · ${arr(d.client_errors).filter((e) => e.first_today).length} new today`}
      >
        <MiniTable
          rows={arr(d.client_errors)}
          drill={(r) => dr('browser_errors', r.id, r.title)}
          cols={[
            { h: 'Error', cell: (r) => r.title },
            { h: 'Screen', cell: (r) => r.screen ?? '–', className: mono },
            { h: 'Times', cell: (r) => num(r.count), num: true },
            { h: 'New', cell: (r) => (r.first_today ? 'first seen today' : '') }
          ]}
        />
      </Section>

      <Section
        id='adoption'
        title='Adoption'
        empty={!arr(d.adoption?.new_routes).length && !arr(d.adoption?.rising).length}
        gist={`${arr(d.adoption?.new_routes).length} newly used · ${arr(d.adoption?.rising).length} rising`}
      >
        <MiniTable
          title='Used today, not in the 7 days before'
          rows={arr(d.adoption?.new_routes)}
          drill={(r) => dr('adoption', r.route, r.route)}
          cols={[
            { h: 'Route', cell: (r) => r.route, className: mono },
            { h: 'Calls', cell: (r) => num(r.n), num: true },
            { h: 'People', cell: (r) => num(r.people), num: true }
          ]}
        />
        <MiniTable
          title='Fastest risers'
          rows={arr(d.adoption?.rising)}
          drill={(r) => dr('adoption', r.route, r.route)}
          cols={[
            { h: 'Route', cell: (r) => r.route, className: mono },
            { h: 'Today', cell: (r) => num(r.today), num: true },
            { h: '7-day avg', cell: (r) => num(r.week_avg), num: true }
          ]}
        />
      </Section>

      <Section
        id='support'
        title='Support'
        empty={!d.support}
        gist={`${num(d.support?.opened)} opened · ${num(d.support?.closed)} closed · ${num(d.support?.open_total)} open`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat label='Opened' value={num(d.support?.opened)} drill={dr('support')} />
          <Stat label='Closed' value={num(d.support?.closed)} drill={dr('support')} />
          <Stat label='Open now' value={num(d.support?.open_total)} drill={dr('support')} />
          <Stat
            label='Oldest open'
            value={d.support?.oldest_open_days == null ? '–' : `${d.support.oldest_open_days} days`}
            drill={dr('support')}
          />
        </div>
        <MiniTable
          title='Topics'
          rows={arr(d.support?.topics)}
          drill={(r) => dr('support', r.topic, r.topic)}
          cols={[
            { h: 'Topic', cell: (r) => r.topic },
            { h: 'Tickets', cell: (r) => num(r.n), num: true }
          ]}
        />
        <MiniTable
          title='Opened today'
          rows={arr(d.support?.opened_today)}
          drill={(r) => dr('support', r.title, r.title)}
          cols={[
            { h: 'Ticket', cell: (r) => r.title },
            { h: 'Status', cell: (r) => r.status }
          ]}
        />
      </Section>

      <Section
        id='ai'
        title='AI use'
        empty={!d.ai}
        gist={`${num(d.ai?.calls)} calls · ${formatKpi(d.ai?.cost_usd, 'usd')} · ${num(d.ai?.errors)} errors`}
      >
        <div className='flex flex-wrap gap-x-6 gap-y-2'>
          <Stat label='Calls' value={num(d.ai?.calls)} drill={dr('ai_calls')} />
          <Stat label='Spend' value={formatKpi(d.ai?.cost_usd, 'usd')} drill={dr('ai_calls')} />
          <Stat label='Errors' value={num(d.ai?.errors)} drill={dr('ai_calls', 'errors')} />
          <Stat label='Refusals' value={num(d.ai?.refusals)} drill={dr('ai_calls', 'refusals')} />
          <Stat
            label='Thumbs up'
            value={num(d.ai?.thumbs_up)}
            drill={dr('ai_calls', 'thumbs_up')}
          />
          <Stat
            label='Thumbs down'
            value={num(d.ai?.thumbs_down)}
            drill={dr('ai_calls', 'thumbs_down')}
          />
        </div>
        <MiniTable
          title='By feature'
          rows={arr(d.ai?.by_feature)}
          drill={(r) => dr('ai_calls', r.feature, r.feature)}
          cols={[
            { h: 'Feature', cell: (r) => r.feature },
            { h: 'Calls', cell: (r) => num(r.calls), num: true },
            { h: 'Spend', cell: (r) => formatKpi(r.cost_usd, 'usd'), num: true },
            { h: 'Errors', cell: (r) => num(r.errors), num: true }
          ]}
        />
      </Section>

      <Section
        id='data-quality'
        title='Data quality'
        empty={!arr(d.data_quality).length}
        gist={`${num(arr(d.data_quality).reduce((a, b) => a + b.violations, 0))} problems in ${arr(d.data_quality).length} collections`}
      >
        <MiniTable
          rows={arr(d.data_quality)}
          drill={(r) => dr('data_quality', r.collection, r.collection)}
          cols={[
            { h: 'Collection', cell: (r) => r.collection, className: mono },
            { h: 'Problems', cell: (r) => num(r.violations), num: true },
            { h: 'Last run', cell: (r) => num(r.prev), num: true },
            { h: 'Checked', cell: (r) => num(r.checked), num: true }
          ]}
        />
      </Section>

      <Section
        id='owners'
        title='Who has work waiting'
        empty={!arr(d.owners).length}
        gist={`${arr(d.owners).length} people · ${num(arr(d.owners).reduce((a, b) => a + b.waiting, 0))} items`}
      >
        <MiniTable
          rows={arr(d.owners)}
          drill={(r) => dr('owners', r.person, r.person)}
          cols={[
            { h: 'Person', cell: (r) => r.person },
            { h: 'Waiting', cell: (r) => num(r.waiting), num: true },
            { h: 'Past deadline', cell: (r) => num(r.sla_breached), num: true },
            { h: 'At risk', cell: (r) => num(r.at_risk), num: true }
          ]}
        />
      </Section>

      {sections.map((s) => (
        <Section
          key={s.key}
          id={`ext-${s.key}`}
          title={s.title}
          empty={!arr(s.rows).length}
          gist={arr(s.rows)
            .slice(0, 2)
            .map((r) => `${r.label} ${formatKpi(r.value, r.unit)}`)
            .join(' · ')}
        >
          <MiniTable
            rows={arr(s.rows)}
            cols={
              [
                { h: 'Measure', cell: (r) => r.label },
                { h: 'Today', cell: (r) => formatKpi(r.value, r.unit), num: true },
                { h: '7-day avg', cell: (r) => formatKpi(r.week_avg, r.unit), num: true },
                {
                  h: 'Note',
                  cell: (r) =>
                    r.href && drill?.link ? (
                      <span className='inline-flex items-center gap-1.5'>
                        {r.note ?? ''}
                        <button
                          type='button'
                          data-ops-section-link={r.href}
                          onClick={(e) => {
                            e.stopPropagation()
                            drill.link?.(r.href as string)
                          }}
                          className='font-medium text-nvr-cyan hover:underline'
                        >
                          Open
                        </button>
                      </span>
                    ) : (
                      (r.note ?? '')
                    )
                }
              ] as Col<(typeof s.rows)[number]>[]
            }
            drill={(r) =>
              dr('section', `${s.key}.${(r as { key?: string }).key ?? r.label}`, r.label)
            }
          />
        </Section>
      ))}
    </div>
  )
}

function hourLabel(h: number): string {
  const hr = ((h + 11) % 12) + 1
  return `${hr}:00 ${h < 12 || h === 24 ? 'AM' : 'PM'}`
}

function hourShort(h: number): string {
  const hr = ((h + 11) % 12) + 1
  return `${hr}${h < 12 || h === 24 ? 'a' : 'p'}`
}
