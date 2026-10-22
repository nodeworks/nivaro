import { registerFault } from '../catalog.js'

/**
 * Cron leader-lease split (#2833). The lease (`plugins/cron.ts` CronLeader) asks
 * `chaosPoint('cron.lease')` on every renew round; on the targeted replica the lease lapses
 * (`expire`), is dropped (`drop`) or is dropped while this process goes on believing it leads
 * (`split`), so another replica takes it in the middle of whatever is running. Afterwards
 * `GET /api/chaos/checks/cron-overlap?since=` reads the job runs for the same job running twice
 * at once, runs left half-finished, and the jobs that are not safe to run twice; the drill notes
 * the same check on its run when the window ends.
 */

registerFault({
  key: 'cron_lease_split',
  label: 'Scheduler lease split',
  area: 'redis',
  proves:
    'When the scheduler lease moves in the middle of a run, another replica takes over and no job runs twice at once — or the check names every job that did and every job not safe to.',
  claim_keys: ['cron.no_double_run'],
  targets: ['node', 'all'],
  params: {
    mode: {
      type: 'enum',
      label: 'How the lease is lost',
      options: ['expire', 'drop', 'split'],
      default: 'expire'
    }
  },
  max_seconds: 300,
  default_seconds: 90,
  points: ['cron.lease'],
  danger: 'medium',
  apply_scope: 'every',
  async apply(fault, { app, origin }) {
    const { CHAOS_NODE } = await import('../registry.js')
    const { cronSchedulers, cronJobsOf } = await import('../cron-overlap.js')
    const held = (await cronSchedulers(app)).some((c) => c.leader?.isLeader())
    const here =
      fault.target.kind === 'all' ||
      (fault.target.kind === 'node' && fault.target.node === CHAOS_NODE)
    const { addRunEvent } = await import('../drill.js')
    if (here && fault.run_id) {
      await addRunEvent(fault.run_id, 'note', {
        cron_lease: held ? 'held here — lapsing now' : 'not held here',
        node: CHAOS_NODE
      }).catch(() => null)
    }
    // Act now rather than at the next renew round (≤ 10 s away).
    if (here) for (const c of await cronSchedulers(app)) await c.leader?.renew().catch(() => {})
    if (!origin) return
    // The replica that armed it writes the overlap check when the window ends.
    const since = new Date(fault.started_at)
    // Never awaited by the release: Stop all must not wait on a database read.
    return () => {
      if (!fault.run_id) return
      const runId = fault.run_id
      void (async () => {
        const { checkCronOverlap } = await import('../cron-overlap.js')
        const report = await checkCronOverlap(await cronJobsOf(app), { since })
        await addRunEvent(runId, 'note', {
          check: 'cron-overlap',
          runs: report.runs,
          overlaps: report.overlaps.length,
          stuck: report.stuck.length,
          overlapped_jobs: [...new Set(report.overlaps.map((o) => o.job_id))].slice(0, 20),
          href: `/api/chaos/checks/cron-overlap?since=${encodeURIComponent(since.toISOString())}`
        })
      })().catch(() => null)
    }
  }
})
