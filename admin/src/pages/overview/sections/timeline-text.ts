import type { TimelineBucket } from './types'

/** Words for one half-hour slot — the hover text and the screen-reader label. Pure. */
export function bucketSummary(b: TimelineBucket): string {
  if (b.total === 0) return 'Nothing ran'
  const parts: string[] = []
  const n = (count: number, one: string, many: string) =>
    count > 0 ? `${count} ${count === 1 ? one : many}` : null
  for (const p of [
    b.failed > 0 ? `${b.failed} failed` : null,
    n(b.kinds.deploy, 'deploy', 'deploys'),
    n(b.kinds.import, 'import', 'imports'),
    n(b.kinds.config, 'config change', 'config changes'),
    n(b.kinds.job, 'job run', 'job runs')
  ])
    if (p) parts.push(p)
  return parts.join(', ')
}

/** How a slot's mark looks: the most important thing in it wins. */
export function bucketTone(b: TimelineBucket): 'failed' | 'deploy' | 'change' | 'jobs' | 'empty' {
  if (b.total === 0) return 'empty'
  if (b.failed > 0) return 'failed'
  if (b.kinds.deploy > 0) return 'deploy'
  if (b.kinds.import > 0 || b.kinds.config > 0) return 'change'
  return 'jobs'
}
