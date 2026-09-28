# @nivaro/extension-kit

The contract a Nivaro extension is written against.

An extension's entry module cannot import `api/src` — the API compiles with
`rootDir: src`, and a mounted extension runs against a built image that ships
no source. Before this package, every extension kept hand-copied mirrors of
the types it needed and re-implemented the small helpers the API already had.
This package is the one place those live: the API imports its extension
contract from here, and so does the extension.

```ts
import {
  defineExtension,
  requesterInsertFields,
  type ExtensionContext,
  type IntegrationSignal
} from '@nivaro/extension-kit'

export default defineExtension({
  id: 'my-extension',
  env: [{ name: 'PARTNER_TOKEN', required: true, secret: true }],
  async register(ctx: ExtensionContext) {
    ctx.hooks.after('orders', 'create', async ({ result }) => {
      /* … */
    })
    ctx.integrations.registerSignal(mySignal satisfies IntegrationSignal)
  }
})
```

## What is in it

- **Context** — `ExtensionContext`, `ExtensionDefinition`, settings and
  environment declarations, cron options.
- **Registrations** — every shape the context accepts: bulk and item actions,
  readiness and integrity checks, notes providers, mail types, digest
  sections, links, storage adapters, field types, validators, import parsers,
  chat-bot tools, event sources.
- **Flows** — operation and trigger registrations, the execution context.
- **Integrations** — obligation kinds, signals, signal actions.
- **Imports** — the import-processor contract and run-report shapes.
- **Operations** — `OpsTaskDef` (repairs and backfills run from the console),
  `ConfigSeedDef` (checked-in configuration rows with a drift report) and
  `SchemaStepDef` (versioned DDL an extension owns, run once at load under
  the migration lock).
- **Helpers** — `hasColumn(db, table, column)` (a per-database column probe
  for writers that must survive an unmigrated database) and
  `requesterInsertFields` / `requesterSelectColumns` for the ERP submission
  tables.

Types are exported with `export type`; the helpers and the test context are
the only runtime code.

## Testing an extension

`createTestContext()` is a context whose every effect is recorded instead of
sent — notifications, external calls, activity, flow emits, obligations —
and whose registrations can be run by the test: `runHooks`, `runCron`,
`deliverEvent`, `invoke` (a route the extension registered). Its database is
`createTestDb({ tables })`, an in-memory knex-shaped fake covering the chain
extensions use (where / whereIn / first / pluck / count / insert / update /
del, `raw`, `schema.hasColumn`, `transaction`); joins are accepted and
ignored, so seed the joined columns on the row you expect back.

```ts
const ctx = createTestContext({ tables: { orders: [{ id: 1, owner: 'u1' }] } })
await myExtension.register(ctx)
await ctx.runHooks('orders', 'create', 'after', { keys: [1], result: { id: 1, owner: 'u1' } })
expect(ctx.calls.notifications).toEqual([{ userId: 'u1', opts: { subject: 'Order 1', message: 'created' } }])
const res = await ctx.invoke('GET', '/api/demo/orders/1')
```

## Versioning

The kit follows the API: a release that adds to the context adds to the kit
in the same commit. An extension built against an older kit keeps working —
members are only ever added.
