/**
 * Set the reference label of external APIs — the word records put before the number a
 * partner gives back ("accepted it at 10:43 AM — PO 12345"). The same setting as External
 * APIs → <api> → Reference label, stored in `nivaro_external_apis.integration_config
 * .reference_label` (services/send-status.ts). Run through `node scripts/partner-reference-labels.mjs`.
 *
 *   node scripts/partner-reference-labels.mjs --set "Ledger=PO" --set "Shop=order"   DRY RUN
 *   … --execute                                                                         writes
 *   node scripts/partner-reference-labels.mjs --set "Ledger=" --execute    back to "reference"
 *
 * APIs are matched by name, case-blind. Every other integration_config key is kept. A name
 * that matches no API is reported and skipped. Writes the rows directly (a one-time config
 * change): running APIs read it on the next send-status read.
 */
import { db } from '../db/index.js'
import { cleanReferenceLabel } from '../services/send-status.js'

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')

function sets(): Array<{ name: string; label: string | null }> {
  const out: Array<{ name: string; label: string | null }> = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--set' || !args[i + 1]) continue
    const raw = args[i + 1]
    const eq = raw.indexOf('=')
    if (eq <= 0) continue
    out.push({ name: raw.slice(0, eq).trim(), label: cleanReferenceLabel(raw.slice(eq + 1)) })
  }
  return out
}

async function main(): Promise<number> {
  const wanted = sets()
  if (wanted.length === 0) {
    console.error('Nothing to set: pass --set "<api name>=<label>" (one per API).')
    return 2
  }
  const rows = (await db('nivaro_external_apis').select(
    'id',
    'name',
    'integration_config'
  )) as Array<{ id: number; name: string; integration_config: string | null }>
  let changes = 0
  for (const w of wanted) {
    const row = rows.find((r) => r.name.trim().toLowerCase() === w.name.toLowerCase())
    if (!row) {
      console.log(`- ${w.name}: no external API by that name — skipped`)
      continue
    }
    let cfg: Record<string, unknown> = {}
    try {
      const parsed = row.integration_config ? JSON.parse(row.integration_config) : {}
      cfg = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      console.log(`- ${row.name}: its integration_config is not valid JSON — skipped`)
      continue
    }
    const now = cleanReferenceLabel(cfg.reference_label)
    if (now === w.label) {
      console.log(`- ${row.name}: already "${now ?? 'reference'}"`)
      continue
    }
    console.log(`- ${row.name}: "${now ?? 'reference'}" → "${w.label ?? 'reference'}"`)
    changes++
    if (!EXECUTE) continue
    if (w.label) cfg.reference_label = w.label
    else delete cfg.reference_label
    await db('nivaro_external_apis')
      .where({ id: row.id })
      .update({
        integration_config: Object.keys(cfg).length > 0 ? JSON.stringify(cfg) : null,
        updated_at: new Date()
      })
  }
  if (!EXECUTE) console.log(`Dry run — ${changes} change(s), nothing written. Add --execute.`)
  else console.log(`${changes} change(s) written.`)
  return 0
}

main()
  .then(async (code) => {
    await db.destroy()
    process.exit(code)
  })
  .catch(async (err) => {
    console.error(err)
    await db.destroy().catch(() => {})
    process.exit(1)
  })
