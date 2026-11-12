import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The GraphQL explorer's editors are Monaco. Without its language workers Monaco runs the
// worker code on the page and tries to load the GraphQL and JSON language services by URL,
// which fails with "Cannot read properties of undefined (reading 'toUrl')" (issue log,
// /graphql, 2026-11-10 to 11-12): no validation, no completion, and an error on every visit.
// graphiql ships the Vite worker setup as a side-effect module; the explorer loads it through
// lib/graphql-editor-workers.ts.
//
// Importing it here would need Vite's `?worker` transform inside node_modules, which the test
// runner does not apply, so this guards the three parts that have to stay together. What it
// stands for was checked on a real build: the explorer chunk sets MonacoEnvironment and the
// build emits the editor, JSON and GraphQL worker files.

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(here, rel), 'utf8')

describe('GraphQL explorer editor workers', () => {
  it('the explorer page loads the worker setup', () => {
    expect(read('GraphQLExplorer.tsx')).toMatch(/^import '@\/lib\/graphql-editor-workers'$/m)
  })

  it("the setup is graphiql's own Vite module", () => {
    expect(read('../lib/graphql-editor-workers.ts')).toMatch(
      /^import 'graphiql\/setup-workers\/vite'$/m
    )
  })

  it('the dev server serves that module as it is (pre-bundling it stops the server)', () => {
    const config = read('../../vite.config.ts')
    const exclude = config.match(/exclude:\s*\[([^\]]*)\]/)?.[1] ?? ''
    expect(exclude).toContain("'@graphiql/react/setup-workers'")
  })
})
