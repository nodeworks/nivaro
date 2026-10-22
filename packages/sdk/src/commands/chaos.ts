/**
 * Chaos engineering reads (admin). `chaosWhatIf` answers "what breaks if this dependency dies?"
 * (#2860): the degradation claims and when each was last proven, the blast radius from recorded
 * traffic, the last drills, and a DRAFT experiment with a builder link. It never arms a fault.
 */
import { type Command, cmd } from '../command.js'

export interface ChaosWhatIfAnswer {
  dependency: { key: string; label: string; map_node: string | null }
  claims: Array<{
    key: string
    statement: string
    status: string
    last_run_at: string | null
    verdict: string | null
    source: 'scorecard' | 'catalog'
  }>
  blast_radius: Record<string, unknown> & { available: boolean }
  last_runs: Array<{
    id: string
    fault_key: string | null
    label: string
    status: string
    verdict: string | null
    started_at: string | null
  }>
  faults: Array<{ key: string; label: string; proves: string }>
  draft: Record<string, unknown> | null
  builder_href: string | null
  draft_only: true
  note: string
}

/** One dependency (`redis`, `database`, `files`, `mail`, `ai`, `signin`, `partners`, `sockets`, `replica`, `ext:<id>`). */
export function chaosWhatIf(dependency: string): Command<{ data: ChaosWhatIfAnswer }> {
  return cmd('GET', '/chaos/what-if', { dependency })
}
