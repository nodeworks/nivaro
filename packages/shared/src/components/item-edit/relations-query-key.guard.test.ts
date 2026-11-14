import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Prod 2026-11-13: "relations.find is not a function" on a record page with a lines grid. The
// grid cached the relations ARRAY under ['collection-meta', c] while other readers cache the
// whole meta OBJECT there; whichever filled the cache first decided the shape. A relations list
// lives under ['collection-relations', c] only.
const READERS = ['InlineTableField.tsx', 'NestedRelationEditor.tsx', 'RelationCombobox.tsx']

describe('relation lists never share the collection-meta key', () => {
  for (const f of READERS)
    it(f, () => {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
      expect(src).not.toMatch(/queryKey:\s*\['collection-meta'/)
    })
})
