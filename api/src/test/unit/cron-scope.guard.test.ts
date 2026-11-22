import { describe, it } from 'vitest'

// Cron scope guard (Hub phase 5). Task 10 adds services/cron-scope.ts (CORE_CRON_SCOPES) and
// turns these into real checks: every core job id passed to app.cron.schedule — string ids
// scanned from api/src plus the dynamic prefixes (retention-policy-, scheduled-report-, …) —
// must say whether it runs once per app or once per process.

describe('cron scope guard', () => {
  it.todo('every core cron id passed to app.cron.schedule has an entry in CORE_CRON_SCOPES')
  it.todo('every dynamic cron id prefix has an entry in CORE_CRON_SCOPES')
})
