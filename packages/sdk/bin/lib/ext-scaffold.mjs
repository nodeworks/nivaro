/**
 * Extension scaffolder (#1302) — `nivaro ext init <id> [--dir api/extensions]`.
 *
 * Writes `<dir>/<id>/` with an index.ts written against @nivaro/extension-kit
 * (one setting, one hook, one described cron, one route behind requireAuth),
 * a passing test on the kit's createTestContext, and a README naming the
 * context members the starter uses. Refuses an existing directory and an id
 * that is not kebab-case.
 *
 * Plain ESM so the CLI imports it directly and `node --test` covers it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** kebab-case: lowercase words joined by single hyphens, 2–64 characters. */
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Null when the id is usable, otherwise the reason it is not. */
export function validateExtensionId(id) {
  if (typeof id !== 'string' || id.length === 0) return 'An extension id is required'
  if (id.length < 2 || id.length > 64) return 'The id must be 2–64 characters'
  if (!ID.test(id))
    return `"${id}" is not kebab-case — use lowercase letters, digits and single hyphens (my-extension)`
  return null
}

/** The directory the extension goes in when --dir is not given. */
export function defaultExtensionsDir(cwd = process.cwd()) {
  if (existsSync(join(cwd, 'api', 'extensions'))) return join(cwd, 'api', 'extensions')
  if (existsSync(join(cwd, 'extensions', 'tsconfig.json'))) return join(cwd, 'extensions')
  return join(cwd, 'api', 'extensions')
}

function camel(id) {
  return id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

/** The files, by name, for an extension called `id`. */
export function scaffoldFiles(id) {
  // The id is written into source text and a path: only a validated one.
  const bad = validateExtensionId(id)
  if (bad) throw new Error(bad)
  const label = id
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
  const counter = `${camel(id)}Creates`

  const index = `import { defineExtension } from '@nivaro/extension-kit'

/**
 * ${label} — scaffolded by \`nivaro ext init ${id}\`.
 *
 * One of each thing an extension usually starts with: a setting an admin edits
 * on the Extensions page, a hook on record writes, a scheduled job, and a route.
 * The Extensions registry sheet lists each of them once the API loads this file.
 */

/** Creates seen since the last daily summary, per collection. In memory: a
 *  restart starts the count again, which is fine for a summary line. */
const ${counter} = new Map<string, number>()

export default defineExtension({
  id: '${id}',
  settings: [
    {
      key: 'greeting',
      label: 'Greeting',
      type: 'string',
      default: 'Hello',
      description: 'The word GET /api/${id}/hello answers with.'
    }
  ],
  async register(ctx) {
    const { app, auth, hooks, cron, logger } = ctx

    // Route. \`preHandler: auth.requireAuth\` is the gate: the loader records it,
    // and a route with no gate is a warning on the readiness scorecard.
    app.register(
      async (f) => {
        f.get('/${id}/hello', { preHandler: auth.requireAuth }, async () => {
          const greeting = (await ctx.settings?.get('greeting')) ?? 'Hello'
          return { data: { message: \`\${greeting} from ${id}\` } }
        })
      },
      { prefix: '/api' }
    )

    // Hook. After-hooks run once the write has landed; keep them quick, the
    // caller waits for them.
    hooks.after('*', 'create', async ({ collection }) => {
      ${counter}.set(collection, (${counter}.get(collection) ?? 0) + 1)
    })

    // Scheduled job. The id is scoped to this extension; the description is
    // what Background Jobs shows beside it.
    cron.schedule(
      'daily-summary',
      '0 6 * * *',
      async () => {
        const total = [...${counter}.values()].reduce((n, v) => n + v, 0)
        const busiest = [...${counter}.entries()].sort((a, b) => b[1] - a[1])[0]
        ${counter}.clear()
        await ctx.logActivity({
          action: 'daily-summary',
          comment: busiest
            ? \`\${total} record(s) created; most in \${busiest[0]} (\${busiest[1]})\`
            : 'No records created'
        })
        logger.info({ total }, '${id}: daily summary written')
      },
      {
        description: 'One activity line a day counting the records created since the last.',
        idempotent: 'safe'
      }
    )
  }
})
`

  const test = `import { createTestContext } from '@nivaro/extension-kit'
import { describe, expect, it } from 'vitest'
import extension from './index.js'

describe('${id}', () => {
  it('answers the hello route with the configured greeting', async () => {
    const ctx = createTestContext({ settings: { greeting: 'Hi' } })
    await extension.register(ctx)
    const res = await ctx.invoke('GET', '/api/${id}/hello')
    expect(res).toEqual({ status: 200, body: { data: { message: 'Hi from ${id}' } } })
  })

  it('counts creates and reports them from the daily job', async () => {
    const ctx = createTestContext()
    await extension.register(ctx)
    await ctx.runHooks('orders', 'create', 'after', { keys: [1] })
    await ctx.runHooks('orders', 'create', 'after', { keys: [2] })
    await ctx.runCron('daily-summary')
    expect(ctx.calls.activity).toEqual([
      { action: 'daily-summary', comment: '2 record(s) created; most in orders (2)' }
    ])
    expect(ctx.registered.crons.get('daily-summary')?.opts?.description).toBeTruthy()
  })

  it('uses no deprecated kit member', async () => {
    const ctx = createTestContext()
    await extension.register(ctx)
    expect(ctx.calls.deprecations).toEqual([])
  })
})
`

  const readme = `# ${label}

Scaffolded by \`nivaro ext init ${id}\`. The API loads it from \`api/extensions/${id}/\` at boot
(restart the API after adding it); the Extensions page lists it with a registry sheet of
everything it registered.

## What it registers

| Thing | Where | Context member |
|---|---|---|
| Setting \`greeting\` | Extensions page → ${id} → Settings | \`settings\` on the export, read with \`ctx.settings.get('greeting')\` |
| Route \`GET /api/${id}/hello\` | behind \`requireAuth\` | \`ctx.app.register\`, gated with \`ctx.auth.requireAuth\` |
| Hook after every create | all collections | \`ctx.hooks.after('*', 'create', fn)\` |
| Daily job \`daily-summary\` | Background Jobs | \`ctx.cron.schedule(id, expression, fn, { description })\` |
| Activity line | Activity log | \`ctx.logActivity({ action, comment })\` |

## Context members you will reach for next

- \`ctx.database\` — knex on the instance database (raw writes skip hooks, revisions and permissions; prefer the items API for record writes).
- \`ctx.notifyUser(userId, { subject, message })\` — the only way to notify a person.
- \`ctx.callExternalApi(name, { method, path, body })\` — configured external APIs; credentials never reach the extension.
- \`ctx.flows.registerOperation\` / \`registerTrigger\` / \`emit\` — custom flow steps and triggers.
- \`ctx.readiness.registerCheck\`, \`ctx.integrity.registerCheck\` — scored checks and Data Integrity checks.
- \`ctx.events.publish\` / \`on\` — a durable outbox for this extension's own events.
- \`ctx.sql.runLong(sql)\` — one long statement outside knex's request timeout.

The full contract is \`ExtensionContext\` in \`@nivaro/extension-kit\`.

## Test and type-check

\`\`\`bash
cd api
npx vitest run extensions/${id}
npx tsc -p extensions/tsconfig.json
\`\`\`

The test runs the extension against the kit's \`createTestContext()\`: every side effect lands in
\`ctx.calls\`, every registration in \`ctx.registered\`, and \`ctx.calls.deprecations\` lists any
deprecated kit member the extension read.
`

  return { 'index.ts': index, 'index.test.ts': test, 'README.md': readme }
}

/**
 * Writes the extension. Throws (with the reason) on a bad id or an existing
 * directory; answers the paths written.
 */
export function writeScaffold(id, dir) {
  const bad = validateExtensionId(id)
  if (bad) throw new Error(bad)
  if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0'))
    throw new Error('--dir must be a directory path')
  const base = resolve(dir)
  const target = join(base, id)
  // The extension lands exactly one level under --dir, never beside or above it.
  const rel = relative(base, target)
  if (rel !== id || isAbsolute(rel)) throw new Error(`Refusing to write outside ${base}`)
  if (existsSync(target)) throw new Error(`${target} already exists — pick another id or remove it`)
  mkdirSync(target, { recursive: true })
  const written = []
  for (const [name, text] of Object.entries(scaffoldFiles(id))) {
    const file = join(target, name)
    writeFileSync(file, text, 'utf8')
    written.push(file)
  }
  return { target, written, hasTsconfig: existsSync(join(base, 'tsconfig.json')) }
}
