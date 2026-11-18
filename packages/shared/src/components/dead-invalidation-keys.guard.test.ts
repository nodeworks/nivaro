import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Low (shared) 2, realtime gaps 2026-11-17: these invalidations named keys nothing reads, so
// the screen they meant to refresh stayed stale. The record is ['item', c, id]; the owner
// matrix reads ['pipeline-all-owner-groups', template].
const dir = import.meta.dirname
const src = (rel: string) => readFileSync(join(dir, rel), 'utf8')

describe('no dead invalidation keys', () => {
  it.each([
    ['ItemEditForm.tsx', /queryKey: \['items', collection, itemId\]/],
    ['item-edit/GroupSection.tsx', /queryKey: \['items', collection, itemId\]/],
    ['panels/RecordIntegrityBanner.tsx', /queryKey: \[collection, itemId\]/],
    ['pipeline/TeamSuggestions.tsx', /queryKey: \['owner-groups'\]/]
  ])('%s', (file, dead) => {
    expect(src(file)).not.toMatch(dead)
  })
})
