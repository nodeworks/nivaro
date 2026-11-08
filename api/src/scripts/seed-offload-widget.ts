/**
 * One-time seeding of the "People to offload" dashboard card onto EVERY administrator's
 * home page, customised layouts included. Run through `node scripts/seed-offload-widget.mjs`.
 *
 *   node scripts/seed-offload-widget.mjs               DRY RUN (default): reads, writes nothing,
 *                                                       prints what each admin would get
 *   node scripts/seed-offload-widget.mjs --execute     writes
 *
 * What it does, per environment (dev, staging, production — run it on each):
 *   1. Every role default in nivaro_settings.dashboard_role_defaults that belongs to an
 *      administrator role gets the card (new admins and admins who reset their layout start
 *      from it).
 *   2. Every active administrator with a SAVED layout (nivaro_users.preferences.dashboard) gets
 *      the card placed by the rule in services/dashboard-offload-seed.ts (next to "People
 *      needing attention", below that row band; fallbacks documented there).
 *   3. Every administrator is marked (preferences.dashboard_seeds contains "people-to-offload")
 *      so a card they REMOVE is never put back: a re-run skips marked people entirely, and
 *      leaves a layout that already has the card alone.
 *
 * Idempotent. Role defaults are the one place a re-run can re-add a card removed from the
 * DEFAULT itself (there is no per-role mark): a role default that already holds the card is
 * left alone. Never run by the app, a migration or boot. Writes go straight to the tables
 * (no hooks, no activity rows — it is a one-time data seed, like the other scripts).
 */
import { db } from '../db/index.js'
import { normalizeDashboardLayout } from '../services/dashboard-layout.js'
import {
  OFFLOAD_SEED_MARK,
  type OffloadPlacement,
  placeOffloadWidget,
  type SeedLayout
} from '../services/dashboard-offload-seed.js'

const EXECUTE = process.argv.includes('--execute')

function parseObj(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const label = (p: OffloadPlacement) =>
  p.rule === 'anchor' ? `next to ${p.anchor}${p.inSection ? ' (in its section)' : ''}` : p.rule

async function main() {
  console.log(
    `${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — database ${String((db.client as { config?: { connection?: { database?: string } } }).config?.connection?.database ?? '?')}`
  )
  const roles = (await db('nivaro_roles').where('admin_access', true).select('id')) as Array<{
    id: string
  }>
  const roleIds = roles.map((r) => String(r.id).toUpperCase())

  // 1 — role defaults
  const settings = (await db('nivaro_settings').first('dashboard_role_defaults')) as
    | { dashboard_role_defaults?: unknown }
    | undefined
  const defaults = parseObj(settings?.dashboard_role_defaults) ?? {}
  let changedDefaults = 0
  const nextDefaults: Record<string, unknown> = { ...defaults }
  for (const [roleId, layout] of Object.entries(defaults)) {
    if (!roleIds.includes(roleId.toUpperCase())) continue
    const { layout: placed, placement } = placeOffloadWidget(layout as SeedLayout)
    if (placement.rule === 'present') {
      console.log(`role default ${roleId.slice(0, 8)}: already has the card`)
      continue
    }
    const ok = normalizeDashboardLayout(placed)
    if (!ok.layout) {
      console.log(`role default ${roleId.slice(0, 8)}: SKIPPED — ${ok.error}`)
      continue
    }
    nextDefaults[roleId] = ok.layout
    changedDefaults++
    console.log(`role default ${roleId.slice(0, 8)}: card ${label(placement)}`)
  }
  if (changedDefaults && EXECUTE)
    await db('nivaro_settings').update({ dashboard_role_defaults: JSON.stringify(nextDefaults) })

  // 2 + 3 — people
  const users = (await db('nivaro_users')
    .whereIn('role', roleIds)
    .where((w) => w.where('status', 'active').orWhereNull('status'))
    .select('id', 'preferences')) as Array<{ id: string; preferences: unknown }>
  const tally: Record<string, number> = {}
  let marked = 0
  let alreadySeeded = 0
  let unreadable = 0
  for (const u of users) {
    const prefs = parseObj(u.preferences) ?? {}
    const seeds = Array.isArray(prefs.dashboard_seeds) ? (prefs.dashboard_seeds as string[]) : []
    if (seeds.includes(OFFLOAD_SEED_MARK)) {
      alreadySeeded++
      continue
    }
    const next: Record<string, unknown> = {
      ...prefs,
      dashboard_seeds: [...seeds, OFFLOAD_SEED_MARK]
    }
    let what = 'marked (no saved layout — gets it from the role default / seed)'
    if (prefs.dashboard != null) {
      const saved = normalizeDashboardLayout(prefs.dashboard)
      if (!saved.layout) {
        unreadable++
        console.log(`user ${String(u.id).slice(0, 8)}: SKIPPED — saved layout unreadable`)
        continue
      }
      const { layout: placed, placement } = placeOffloadWidget(saved.layout as SeedLayout)
      const ok = normalizeDashboardLayout(placed)
      if (!ok.layout) {
        unreadable++
        console.log(`user ${String(u.id).slice(0, 8)}: SKIPPED — ${ok.error}`)
        continue
      }
      next.dashboard = ok.layout
      what = placement.rule === 'present' ? 'marked (already has the card)' : label(placement)
      tally[what] = (tally[what] ?? 0) + 1
    }
    marked++
    console.log(`user ${String(u.id).slice(0, 8)}: ${what}`)
    if (EXECUTE)
      await db('nivaro_users')
        .where({ id: u.id })
        .update({ preferences: JSON.stringify(next) })
  }

  console.log('\nSummary')
  console.log(`  role defaults changed:   ${changedDefaults}`)
  console.log(`  administrators:          ${users.length}`)
  console.log(
    `  ${EXECUTE ? 'seeded' : 'would be seeded'}:${' '.repeat(EXECUTE ? 10 : 2)}${marked}`
  )
  console.log(`  already seeded earlier:  ${alreadySeeded}`)
  console.log(`  skipped (unreadable):    ${unreadable}`)
  for (const [k, n] of Object.entries(tally)) console.log(`    ${n} × ${k}`)
  if (!EXECUTE) console.log('\nDry run — nothing written. Add --execute to apply.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => db.destroy())
