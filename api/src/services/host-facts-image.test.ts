import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The host facts container reads /proc, /boot and the Docker folders: every base image it is
// built from is pinned by an exact tag AND a digest, so a rebuild never takes whatever a
// floating tag points at that day (security review 2026-10-21, finding 4).
const DOCKERFILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/host-facts/Dockerfile'
)

describe('deploy/host-facts/Dockerfile', () => {
  const froms = readFileSync(DOCKERFILE, 'utf8')
    .split('\n')
    .filter((l) => /^FROM\s/i.test(l))
    .map((l) => l.split(/\s+/)[1])

  it('pins every base by tag and sha256 digest', () => {
    expect(froms.length).toBeGreaterThan(0)
    for (const ref of froms) {
      expect(ref).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/)
    }
  })

  it('uses a dated Debian tag, never the floating bookworm-slim', () => {
    const debian = froms.find((r) => r.startsWith('debian:'))
    expect(debian).toMatch(/^debian:bookworm-\d{8}-slim@/)
  })
})
