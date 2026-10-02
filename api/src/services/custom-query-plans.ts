// api/src/services/custom-query-plans.ts
/**
 * #90 — the plan captured for a SLOW run of a saved custom query (per process, in memory). The
 * execute route stores it right after a slow run; the query editor and the Traffic Map's query
 * panel read it back without re-running the query. Kept out of the route module so a service
 * can read a plan without loading the route graph.
 */
export interface CapturedPlan {
  at: number
  duration_ms: number
  params: Record<string, unknown>
  plan: {
    operators: Array<{ op: string; object: string | null; est_rows: number; cost: number }>
    missing_indexes: string[]
    plan_xml: string
  }
}

const capturedPlans = new Map<number, CapturedPlan>()

/** Keep (replace) the plan of query `id`'s latest slow run. */
export function rememberCapturedPlan(id: number, plan: CapturedPlan): void {
  capturedPlans.set(id, plan)
}

/** The last slow plan captured for query `id` on this process, or null. */
export function capturedPlanFor(id: number): CapturedPlan | null {
  return capturedPlans.get(id) ?? null
}
