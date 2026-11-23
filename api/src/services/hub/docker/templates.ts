import { compareVersions } from '../promote-plan.js'
import type { StackSpec } from './agent-types.js'

/**
 * Stack templates (Hub phase 4, Decision 7): which Nivaro roles a Docker stack runs, how many of
 * each and their limits, per size. Keyed by the lowest Nivaro version they apply to; full image
 * only (slim needs a render peer). Pure data.
 *
 * Task 15: Nivaro 0.3.184 brought NIVARO_ROLE=exporter (background exports only, ticks no crons;
 * services/export-handoff.ts). From that version a large stack adds one `exporter` with the
 * importer's limits; while it is down the importer, then the worker, run exports in its place.
 * Small and medium are the same in both templates. An older image never gets the role.
 */

export type StackSize = 'small' | 'medium' | 'large'
export const STACK_SIZES: readonly StackSize[] = ['small', 'medium', 'large']

export interface StackTemplate {
  /** Lowest Nivaro version (x.y.z) this template applies to. */
  from: string
  sizes: Record<StackSize, StackSpec['roles']>
}

const SMALL: StackSpec['roles'] = [
  // One process, every role (no NIVARO_ROLE).
  { role: 'all', replicas: 1, cpus: 2, memory_mb: 3072 }
]
const MEDIUM: StackSpec['roles'] = [
  { role: 'web', replicas: 2, cpus: 2, memory_mb: 3072 },
  { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 }
]
// Sockets move to the realtime role; web serves none.
const LARGE: StackSpec['roles'] = [
  { role: 'web', replicas: 3, cpus: 2, memory_mb: 3072, env: { SOCKETS: 'off' } },
  { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 },
  { role: 'realtime', replicas: 2, cpus: 1, memory_mb: 1024 },
  { role: 'importer', replicas: 1, cpus: 2, memory_mb: 4096 }
]

/** A fresh copy (render-spec / stack-gather clone again, but the templates never share objects). */
const copy = (roles: StackSpec['roles']): StackSpec['roles'] => structuredClone(roles)

export const STACK_TEMPLATES: StackTemplate[] = [
  {
    from: '0.3.0',
    sizes: { small: copy(SMALL), medium: copy(MEDIUM), large: copy(LARGE) }
  },
  {
    from: '0.3.184',
    sizes: {
      small: copy(SMALL),
      medium: copy(MEDIUM),
      large: [...copy(LARGE), { role: 'exporter', replicas: 1, cpus: 2, memory_mb: 4096 }]
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
