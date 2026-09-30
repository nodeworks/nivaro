/**
 * `pnpm --filter @nivaro/api run partners:check [-- --days 14] [-- --people] [-- --json] [-- --summary]` (#608)
 *
 * Compares what every partner (an API key, or a machine account on a static
 * token) used in the logged window — the fields it read and wrote over REST
 * and GraphQL, the GraphQL root fields its operations call — with the schema
 * as it is now:
 *   - a used collection or field that no longer exists → BREAK, exit 1
 *   - a used field that carries deprecated_at           → warning, exit 0
 * `--people` also judges people on static tokens (scripts, probes).
 * `--summary` prints one line and always exits 0 (the release preflight runs
 * it report-only). Reads the database; writes nothing.
 */
import { db } from '../db/index.js'
import { checkDependencies, setDependencySchemaProvider } from '../services/partner-dependencies.js'
import { buildGraphQLSchema } from '../services/schema-builder.js'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const daysArg = args.indexOf('--days')
const days = daysArg >= 0 ? Number(args[daysArg + 1]) || 14 : 14

// The API process shares its cached schema; here build one (read-only).
let schema: Awaited<ReturnType<typeof buildGraphQLSchema>> | null = null
setDependencySchemaProvider(async () => {
  schema ??= await buildGraphQLSchema()
  return schema
})

let exitCode = 0
try {
  const r = await checkDependencies({ days, includePeople: flag('people') })
  const breaks = r.findings.filter((f) => f.severity === 'break')
  const deprecated = r.findings.filter((f) => f.severity === 'deprecated')
  if (flag('json')) {
    console.log(JSON.stringify(r, null, 2))
  } else if (flag('summary')) {
    console.log(
      `partners check: ${r.callers} partner(s), ${r.fields} used field(s) over ${r.days}d — ` +
        `${breaks.length} missing, ${deprecated.length} deprecated` +
        (breaks.length ? ` (first: ${breaks[0].message})` : '')
    )
  } else {
    console.log(
      `Partners judged: ${r.callers} · fields in use: ${r.fields} · window: ${r.days} days\n`
    )
    for (const f of breaks) {
      console.log(
        `BREAK  ${f.caller} · ${f.collection}${f.field ? `.${f.field}` : ''} · ${f.mode ?? ''} via ${f.via.join('/')} · last ${f.last_seen.slice(0, 10)}\n       ${f.message}`
      )
    }
    for (const f of deprecated) {
      console.log(
        `WARN   ${f.caller} · ${f.collection}.${f.field} · ${f.mode ?? ''} via ${f.via.join('/')} · last ${f.last_seen.slice(0, 10)}\n       ${f.message}`
      )
    }
    if (r.findings.length === 0) console.log('Every used collection and field still exists.')
  }
  if (breaks.length > 0 && !flag('summary')) exitCode = 1
} catch (err) {
  console.error(`partners check failed: ${(err as Error).message}`)
  exitCode = flag('summary') ? 0 : 2
} finally {
  await db.destroy().catch(() => {})
}
process.exit(exitCode)
