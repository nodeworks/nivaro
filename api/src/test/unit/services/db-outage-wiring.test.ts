import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// server.ts cannot be booted in a unit test, so the order of its error handler's steps is
// read from the source. The steps themselves are exercised in db-outage.test.ts.

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')

/** The body of the app's error handler: from setErrorHandler to the next top-level section. */
function errorHandler(source: string): string {
  const start = source.indexOf('app.setErrorHandler(')
  expect(start).toBeGreaterThan(0)
  return source.slice(start, start + 9000)
}

const at = (text: string, needle: string) => {
  const i = text.indexOf(needle)
  expect(i, needle).toBeGreaterThanOrEqual(0)
  return i
}

describe('web error handler', () => {
  const handler = errorHandler(read('server.ts'))

  it('asks, in order: already answered, client left, database unreachable, busy pool, data refusal', () => {
    const sent = at(handler, 'reply.raw.headersSent')
    const left = at(handler, 'clientLeft(err, reply.raw)')
    const unreachable = at(handler, 'answerDbUnavailable(err, req, reply)')
    const busy = at(handler, "requestDbFailure(err) === 'busy'")
    const refusal = at(handler, 'describeDbRefusal(err)')
    expect(sent).toBeLessThan(left)
    expect(left).toBeLessThan(unreachable)
    expect(unreachable).toBeLessThan(busy)
    expect(busy).toBeLessThan(refusal)
  })

  it('counts a cut statement with the outage instead of filing it under its route', () => {
    const cut = at(handler, 'noteCutStatement(err, req)')
    expect(cut).toBeLessThan(at(handler, 'trackError({'))
  })

  it('the busy pool keeps its answer', () => {
    expect(handler).toContain("code: 'SERVER_BUSY'")
  })
})

describe('the outage posture answers what the error handler answers', () => {
  it.each(['server.ts', 'realtime-server.ts'])('%s', (file) => {
    const source = read(file)
    const posture = source.slice(at(source, '!isDbHealthy()'))
    expect(posture.slice(0, 400)).toContain('sendDbUnavailable(reply)')
    // One body for both paths: nobody writes the code by hand any more.
    expect(source).not.toMatch(/code: 'DB_UNAVAILABLE'/)
  })

  it('the realtime error handler takes the same first step', () => {
    const handler = errorHandler(read('realtime-server.ts'))
    expect(at(handler, 'answerDbUnavailable(err, req, reply)')).toBeLessThan(
      at(handler, 'trackError({')
    )
    expect(handler).toContain('noteCutStatement(err, req)')
  })
})
