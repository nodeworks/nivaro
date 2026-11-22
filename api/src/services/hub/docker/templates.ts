import { compareVersions } from '../promote-plan.js'
import type { StackSpec } from './agent-types.js'

/**
 * Stack templates (Hub phase 4, Decision 7): which Nivaro roles a Docker stack runs, how many of
 * each and their limits, per size. Keyed by the lowest Nivaro version they apply to; full image
 * only (slim needs a render peer). There is no "exporter" role (NIVARO_ROLE = web | worker |
 * realtime | importer). Pure data.
 */

export type StackSize = 'small' | 'medium' | 'large'
export const STACK_SIZES: readonly StackSize[] = ['small', 'medium', 'large']

export interface StackTemplate {
  /** Lowest Nivaro version (x.y.z) this template applies to. */
  from: string
  sizes: Record<StackSize, StackSpec['roles']>
}

export const STACK_TEMPLATES: StackTemplate[] = [
  {
    from: '0.3.0',
    sizes: {
      // One process, every role (no NIVARO_ROLE).
      small: [{ role: 'all', replicas: 1, cpus: 2, memory_mb: 3072 }],
      medium: [
        { role: 'web', replicas: 2, cpus: 2, memory_mb: 3072 },
        { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 }
      ],
      // Sockets move to the realtime role; web serves none.
      large: [
        { role: 'web', replicas: 3, cpus: 2, memory_mb: 3072, env: { SOCKETS: 'off' } },
        { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 },
        { role: 'realtime', replicas: 2, cpus: 1, memory_mb: 1024 },
        { role: 'importer', replicas: 1, cpus: 2, memory_mb: 4096 }
      ]
    }
  }
]

export class StackTemplateError extends Error {
  code = 'TEMPLATE_NONE' as const
  constructor(message: string) {
    super(message)
    this.name = 'StackTemplateError'
  }
}

/** The template for a Nivaro version: the highest `from` at or below it; none = TEMPLATE_NONE. */
export function templateFor(version: string): StackTemplate {
  let best: StackTemplate | null = null
  for (const t of STACK_TEMPLATES) {
    if (compareVersions(t.from, version) > 0) continue
    if (!best || compareVersions(t.from, best.from) > 0) best = t
  }
  if (!best) {
    throw new StackTemplateError(
      `No stack template for Nivaro ${version}: Docker stacks need ${STACK_TEMPLATES.map((t) => t.from).sort(compareVersions)[0]} or later.`
    )
  }
  return best
}
