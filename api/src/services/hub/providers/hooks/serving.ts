/**
 * Task 11a: the provider resource types that SERVE an environment — a change to one of them can
 * change what people reach, so the environment's smoke suite runs after it (verify/smoke.ts,
 * source `resource-change:<id>`). Pure.
 */
export const SERVING_TYPES: readonly string[] = Object.freeze([
  'vercel.deployment',
  'vercel.domain',
  'aws.route53_record',
  'aws.load_balancer',
  'aws.listener',
  'aws.target_group',
  'aws.rds_instance'
])

/**
 * Whether a stored change plan (nivaro_hub_resource_changes.plan, JSON text or object) changed a
 * serving resource: at least one non-noop op on a serving type, and the change was not carried by
 * another Hub run (its origin runs its own checks, or nothing serves yet / any more).
 */
export function servingChange(plan: unknown): boolean {
  let p: unknown = plan
  if (typeof plan === 'string') {
    try {
      p = JSON.parse(plan)
    } catch {
      return false
    }
  }
  if (!p || typeof p !== 'object') return false
  const o = p as { ops?: unknown; origin?: unknown }
  if (o.origin) return false
  if (!Array.isArray(o.ops)) return false
  return o.ops.some((op) => {
    const x = op as { kind?: unknown; type?: unknown }
    return x && x.kind !== 'noop' && typeof x.type === 'string' && SERVING_TYPES.includes(x.type)
  })
}
