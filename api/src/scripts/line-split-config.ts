/**
 * Turn "Move lines to a new record" on (or off) for one collection — the same
 * setting as Data Model → Settings → Move lines to a new record, stored in
 * `nivaro_collections.browser_config.line_split` (services/record-split.ts).
 * Run through `node scripts/line-split-config.mjs`.
 *
 *   node scripts/line-split-config.mjs --collection <c> --relation <lines>.<link> \
 *        [--skip a,b] [--link-field f] [--no-copy-links]          DRY RUN (default)
 *   … --execute                                                    writes
 *   node scripts/line-split-config.mjs --collection <c> --off --execute   turns it off
 *
 * Example (a request whose lines may split, the partner's status left behind):
 *   node scripts/line-split-config.mjs --collection requests \
 *        --relation request_lines.request --skip partner_status
 *
 * Every other browser_config key is kept. The relation, skipped fields and link
 * field are checked against the metadata first; nothing is written on a mistake.
 * Writes the row directly (a one-time config change, like the other scripts):
 * running APIs pick it up within the metadata cache window (~30 s).
 */
import { db } from '../db/index.js'
import { parseLineSplitConfig } from '../services/record-split.js'

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const OFF = args.includes('--off')
function arg(name: string): string | null {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}
const list = (v: string | null) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

async function main(): Promise<number> {
  const collection = arg('--collection')
  if (!collection) {
    console.error('--collection is required')
    return 2
  }
  const row = (await db('nivaro_collections').where({ collection }).first('browser_config')) as
    | { browser_config: string | null }
    | undefined
  if (!row) {
    console.error(`No collection "${collection}" is registered.`)
    return 2
  }
  let bc: Record<string, unknown> = {}
  try {
    bc = row.browser_config ? (JSON.parse(row.browser_config) as Record<string, unknown>) : {}
  } catch {
    console.error('The stored browser_config is not valid JSON — fix it before running this.')
    return 2
  }
  console.log('Now:', JSON.stringify(bc.line_split ?? null))

  if (OFF) {
    const { line_split: _gone, ...rest } = bc
    bc = rest
  } else {
    const relations = list(arg('--relation'))
    const skip = list(arg('--skip'))
    const linkField = arg('--link-field')
    if (relations.length === 0) {
      console.error('--relation <lines collection>.<link field> is required (or --off)')
      return 2
    }
    const rels = (await db('nivaro_relations')
      .where({ one_collection: collection })
      .whereNull('junction_field')
      .whereNotNull('one_field')
      .select('many_collection', 'many_field')) as Array<{
      many_collection: string
      many_field: string
    }>
    for (const r of relations) {
      if (!rels.some((x) => `${x.many_collection}.${x.many_field}` === r)) {
        console.error(
          `"${r}" is not a line list of ${collection}. Line lists: ${rels.map((x) => `${x.many_collection}.${x.many_field}`).join(', ') || 'none'}`
        )
        return 2
      }
    }
    const fields = new Set(
      (
        (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
          field: string
        }>
      ).map((f) => f.field)
    )
    const unknown = [...skip, ...(linkField ? [linkField] : [])].filter((f) => !fields.has(f))
    if (unknown.length > 0) {
      console.error(`Not fields of ${collection}: ${unknown.join(', ')}`)
      return 2
    }
    bc = {
      ...bc,
      line_split: {
        enabled: true,
        relations,
        ...(skip.length ? { skip_fields: skip } : {}),
        ...(linkField ? { link_field: linkField } : {}),
        ...(args.includes('--no-copy-links') ? { copy_links: false } : {})
      }
    }
    if (!parseLineSplitConfig(bc)) {
      console.error('The resulting setting would not read as on — nothing written.')
      return 2
    }
  }
  console.log('New:', JSON.stringify(bc.line_split ?? null))
  if (!EXECUTE) {
    console.log('Dry run — nothing written. Add --execute to write.')
    return 0
  }
  await db('nivaro_collections')
    .where({ collection })
    .update({ browser_config: Object.keys(bc).length > 0 ? JSON.stringify(bc) : null })
  console.log(`Written to ${collection}.`)
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
