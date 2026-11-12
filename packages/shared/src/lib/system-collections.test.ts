import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  hasRecordExtras,
  isFileCollection,
  isSystemCollection,
  mayHavePipeline
} from './system-collections'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(here, rel), 'utf8')

describe('system tables, as the screens know them', () => {
  it('names nivaro_ and directus_ tables, whatever the case, and nothing else', () => {
    expect(isSystemCollection('nivaro_users')).toBe(true)
    expect(isSystemCollection('NIVARO_FILES')).toBe(true)
    expect(isSystemCollection('directus_files')).toBe(true)
    expect(isSystemCollection('workflows')).toBe(false)
    expect(isSystemCollection('my_nivaro_notes')).toBe(false)
    expect(isSystemCollection(null)).toBe(false)
    expect(isSystemCollection('')).toBe(false)
  })

  it('uses the same rule as the server', () => {
    const rule = '/^(nivaro_|directus_)/i'
    expect(read('../../../../api/src/services/system-collections.ts')).toContain(
      `const SYSTEM_COLLECTION = ${rule}`
    )
    expect(read('./system-collections.ts')).toContain(`const SYSTEM_COLLECTION = ${rule}`)
  })

  it('a system table has none of a business record’s extras', () => {
    expect(hasRecordExtras('workflows')).toBe(true)
    expect(hasRecordExtras('nivaro_users')).toBe(false)
    expect(hasRecordExtras('directus_users')).toBe(false)
  })

  it('only addendums have a pipeline among system tables', () => {
    expect(mayHavePipeline('workflows')).toBe(true)
    expect(mayHavePipeline('nivaro_addendums')).toBe(true)
    expect(mayHavePipeline('nivaro_users')).toBe(false)
    expect(mayHavePipeline('nivaro_saved_views')).toBe(false)
  })

  it('knows the file tables, which the items API never serves', () => {
    expect(isFileCollection('nivaro_files')).toBe(true)
    expect(isFileCollection('directus_files')).toBe(true)
    expect(isFileCollection('workflows_files')).toBe(false)
    expect(isFileCollection(undefined)).toBe(false)
  })
})
