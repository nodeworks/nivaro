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
- **Helpers** — `hasColumn(db, table, column)` (a per-database column probe
  for writers that must survive an unmigrated database) and
  `requesterInsertFields` / `requesterSelectColumns` for the ERP submission
  tables.

Types are exported with `export type`; the helpers are the only runtime code.

## Versioning

The kit follows the API: a release that adds to the context adds to the kit
in the same commit. An extension built against an older kit keeps working —
members are only ever added.
