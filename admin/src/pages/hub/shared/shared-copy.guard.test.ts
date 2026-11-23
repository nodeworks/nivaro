import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUN_ERROR_COPY } from '../hub-api'
import { SHARED_COPY, WARNING_COPY } from './shared-api'
import { UPGRADE_COPY } from './shared-upgrade-api'

// Parked wave C: every code a shared upgrade or placement run stops with has plain words (the
// run panel and the Hub deploys history show them), and the codes List B added have copy.

const api = join(process.cwd(), '..', 'api', 'src', 'services', 'hub', 'shared')
const codesIn = (file: string, re: RegExp) =>
  [...readFileSync(join(api, file), 'utf8').matchAll(re)].map((m) => m[1])

describe('shared run and route copy', () => {
  it('has plain words for every code a shared upgrade or placement run stops with', () => {
    const codes = new Set([
      ...codesIn('upgrade-run.ts', /new Stop\(\s*'[a-z]+',\s*'([A-Z][A-Z_]{3,})'/g),
      ...codesIn('place.ts', /new StepFailure\(\s*'([A-Z][A-Z_]{3,})'/g),
      'START_FAILED',
      'STEP_FAILED'
    ])
    expect(codes.size).toBeGreaterThan(10)
    expect([...codes].filter((c) => !RUN_ERROR_COPY[c])).toEqual([])
  })

  it('words the codes List B added (P6-29 and the parked Task 5 items)', () => {
    expect(UPGRADE_COPY.DOWNGRADE_NEEDS_CONFIRM?.title).toBeTruthy()
    expect(RUN_ERROR_COPY.SWARM_DEGRADED?.title).toBeTruthy()
    expect(SHARED_COPY.SECRETS_CHANGED?.title).toBeTruthy()
    expect(WARNING_COPY.REDIS_URL_NOT_APPLIED?.title).toBeTruthy()
  })
})
