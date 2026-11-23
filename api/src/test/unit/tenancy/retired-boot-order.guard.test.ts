import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Hub phase 6 final review (core) M4: a hub-linked dedicated app that was retired (moved away)
// and restarts must not tick a scheduled job or drain a staged import into the moved app's
// database before it has read its retired flag. buildServer starts the scheduler lease election
// (cron plugin) and the drainers, so the boot read happens inside buildServer, right after Redis
// and before both. (index.ts reads it again for the realtime process and logs the state.)

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const server = readFileSync(join(SRC, 'server.ts'), 'utf8')

describe('the retired flag is read before anything ticks or drains', () => {
  const at = (needle: string) => {
    const i = server.indexOf(needle)
    expect(i, needle).toBeGreaterThan(-1)
    return i
  }

  it('after Redis, before the cron plugin and the import / export drainers', () => {
    const read = at('await startRetiredWatch(')
    expect(read).toBeGreaterThan(at('await app.register(redisPlugin)'))
    expect(read).toBeLessThan(at('await app.register(cronPlugin)'))
    expect(read).toBeLessThan(at('startImportDrainer(app)'))
    expect(read).toBeLessThan(at('startExportDrainer'))
  })

  it('only on a hub-linked dedicated app (HUB_TOKEN, one app per process)', () => {
    const read = at('await startRetiredWatch(')
    const guard = server.lastIndexOf('if (', read)
    expect(server.slice(guard, read)).toMatch(
      /hubLinkToken\(\)\s*&&\s*tenantSource\(\)\s*===\s*null/
    )
  })
})
