import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as rr from '../../../services/release-runs.js'
import {
  deriveState,
  markerOutcome,
  parseEvents,
  type RunRecord,
  readLogChunk,
  validateStartBody
} from '../../../services/release-runs.js'

const rec: RunRecord = {
  id: 'r1',
  mode: 'go',
  args: ['--go', '--events'],
  pid: 4242,
  started_at: '2026-09-24T20:00:00.000Z',
  started_by: 'user-1'
}

describe('parseEvents', () => {
  it('reads @@event and @@plan lines and ignores everything else', () => {
    const log = [
      'release-chain — 3 commit(s)',
      '@@plan {"commits":3,"lines":[]}',
      '@@event {"stage":"preflight","status":"start","at":"2026-09-24T20:00:01.000Z"}',
      '20:00:02  typecheck api',
      '@@event {"stage":"preflight","status":"ok","at":"2026-09-24T20:00:30.000Z"}',
      '@@event not json'
    ].join('\n')
    const r = parseEvents(log)
    expect(r.plan).toEqual({ commits: 3, lines: [] })
    expect(r.events.map((e) => `${e.stage}:${e.status}`)).toEqual([
      'preflight:start',
      'preflight:ok'
    ])
  })
})

describe('markerOutcome', () => {
  it('reads DONE with the version', () => {
    expect(markerOutcome('x\n### DONE — nivaro 0.1.341\n')).toEqual({
      outcome: 'done',
      version: '0.1.341'
    })
  })
  it('reads FAILED with the stage', () => {
    expect(markerOutcome('### FAILED at artifacts: image never became true\n')).toEqual({
      outcome: 'failed',
      failed_stage: 'artifacts'
    })
  })
  it('is null with no marker', () => {
    expect(markerOutcome('still going')).toBeNull()
  })
})

describe('deriveState', () => {
  it('alive pid is running regardless of the log', () => {
    expect(deriveState(rec, true, '### DONE — nivaro 0.1.341').state).toBe('running')
  })
  it('dead pid with DONE is done and carries the version', () => {
    const s = deriveState(rec, false, '### DONE — nivaro 0.1.341')
    expect(s.state).toBe('done')
    expect(s.version).toBe('0.1.341')
  })
  it('dead pid with FAILED is failed at that stage', () => {
    const s = deriveState(rec, false, '### FAILED at frontends: boom')
    expect(s.state).toBe('failed')
    expect(s.failed_stage).toBe('frontends')
  })
  it('dead pid with no marker is lost', () => {
    expect(deriveState(rec, false, 'partial output').state).toBe('lost')
  })
  it('a recorded cancelled outcome wins over the log', () => {
    expect(
      deriveState({ ...rec, outcome: 'cancelled' }, false, '### DONE — nivaro 0.1.341').state
    ).toBe('cancelled')
  })
})

describe('validateStartBody', () => {
  it('accepts the enum inputs and builds the fixed argument list', () => {
    const r = validateStartBody({ bump: 'minor', from: 'frontends', with_sdk: true })
    expect(r).toEqual({
      ok: true,
      args: ['--go', '--events', '--bump', 'minor', '--from', 'frontends', '--with-sdk']
    })
  })
  it('defaults to a patch bump', () => {
    expect(validateStartBody({})).toEqual({
      ok: true,
      args: ['--go', '--events', '--bump', 'patch']
    })
  })
  it('rejects anything outside the enums', () => {
    expect(validateStartBody({ bump: 'major; rm -rf /' }).ok).toBe(false)
    expect(validateStartBody({ from: 'nowhere' }).ok).toBe(false)
    expect(validateStartBody({ with_sdk: 'yes' }).ok).toBe(false)
  })
})

describe('readLogChunk', () => {
  it('returns the tail after the offset', () => {
    expect(readLogChunk('abcdef', 3)).toEqual({ chunk: 'def', next_offset: 6 })
  })
  it('an offset past the end returns from the start (log was recreated)', () => {
    expect(readLogChunk('abc', 10)).toEqual({ chunk: 'abc', next_offset: 3 })
  })
})

describe('disk-backed runs', () => {
  let dir: string
  let original: typeof rr.runtime
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-runs-'))
    original = { ...rr.runtime }
    rr.runtime.runsDir = () => dir
  })
  afterEach(() => {
    Object.assign(rr.runtime, original)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a record with a dead pid and no marker lists as lost, and the outcome is written back once', async () => {
    writeFileSync(
      join(dir, 'r9.json'),
      JSON.stringify({
        id: 'r9',
        mode: 'go',
        args: [],
        pid: 999999,
        started_at: '2026-09-24T20:00:00.000Z',
        started_by: 'u'
      })
    )
    writeFileSync(join(dir, 'r9.log'), 'partial')
    const runs = await rr.listRuns()
    expect(runs[0].state).toBe('lost')
    expect(JSON.parse(readFileSync(join(dir, 'r9.json'), 'utf8')).outcome).toBe('lost')
  })

  it('cancel on a run that already exited is a no-op that reports the derived outcome', async () => {
    writeFileSync(
      join(dir, 'r10.json'),
      JSON.stringify({
        id: 'r10',
        mode: 'go',
        args: [],
        pid: 999999,
        started_at: '2026-09-24T20:00:00.000Z',
        started_by: 'u'
      })
    )
    writeFileSync(join(dir, 'r10.log'), '### DONE — nivaro 0.1.341\n')
    const s = await rr.cancelRun('r10')
    expect(s?.state).toBe('done')
  })

  it('startRun refuses while current.json names a live pid of ours', async () => {
    writeFileSync(join(dir, 'current.json'), JSON.stringify({ id: 'live' }))
    writeFileSync(
      join(dir, 'live.json'),
      JSON.stringify({
        id: 'live',
        mode: 'go',
        args: [],
        pid: process.pid,
        started_at: new Date().toISOString(),
        started_by: 'u'
      })
    )
    rr.runtime.isOurProcess = () => true
    await expect(rr.startRun({ mode: 'go', args: ['--go'], user: 'u' })).rejects.toBeInstanceOf(
      rr.RunLockedError
    )
  })

  it('startRun spawns a detached child and writes the record + current.json', async () => {
    // A stand-in script: prints a DONE marker and exits.
    const script = join(dir, 'fake-chain.mjs')
    writeFileSync(script, "console.log('### DONE — nivaro 9.9.9')\n")
    rr.runtime.scriptPath = () => script
    const rec = await rr.startRun({ mode: 'go', args: ['--go', '--events'], user: 'u1' })
    expect(rec.pid).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8')).id).toBe(rec.id)
    let read = await rr.readRun(rec.id)
    for (let i = 0; i < 100 && read?.run.state !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 100))
      read = await rr.readRun(rec.id)
    }
    expect(read?.run.state).toBe('done')
    expect(read?.log).toContain('### DONE')
  })

  it('an id that escapes the runs folder is refused before any path is built', async () => {
    // Runs live one level down so '../package' would land on a sentinel we own.
    const runs = join(dir, 'runs')
    rr.runtime.runsDir = () => runs
    const sentinel = join(dir, 'package.json')
    const body = JSON.stringify({
      id: '../package',
      mode: 'go',
      args: [],
      pid: 999999,
      started_at: '2026-09-24T20:00:00.000Z',
      started_by: 'u'
    })
    writeFileSync(sentinel, body)
    const repoPkg = join(rr.repoRoot(), 'package.json')
    const repoBefore = readFileSync(repoPkg, 'utf8')
    expect(await rr.cancelRun('../package')).toBeNull()
    expect(await rr.readRun('../package')).toBeNull()
    expect(readFileSync(sentinel, 'utf8')).toBe(body)
    expect(readFileSync(repoPkg, 'utf8')).toBe(repoBefore)
  })

  it('two starts in the same tick: exactly one spawns, the other is locked out', async () => {
    const script = join(dir, 'fake-chain.mjs')
    writeFileSync(script, "console.log('### DONE — nivaro 9.9.9')\n")
    rr.runtime.scriptPath = () => script
    const results = await Promise.allSettled([
      rr.startRun({ mode: 'go', args: ['--go'], user: 'u1' }),
      rr.startRun({ mode: 'go', args: ['--go'], user: 'u2' })
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(rr.RunLockedError)
  })

  it('a cancelled run whose process is still alive keeps the lock', async () => {
    writeFileSync(join(dir, 'current.json'), JSON.stringify({ id: 'exiting' }))
    writeFileSync(
      join(dir, 'exiting.json'),
      JSON.stringify({
        id: 'exiting',
        mode: 'go',
        args: [],
        pid: process.pid,
        started_at: new Date().toISOString(),
        started_by: 'u',
        outcome: 'cancelled'
      })
    )
    rr.runtime.isOurProcess = () => true
    const cur = await rr.currentRun()
    expect(cur?.id).toBe('exiting')
    expect(cur?.state).toBe('cancelled')
    await expect(rr.startRun({ mode: 'go', args: ['--go'], user: 'u' })).rejects.toBeInstanceOf(
      rr.RunLockedError
    )
  })

  it('a cancelled run whose process is still alive can be cancelled again', async () => {
    writeFileSync(
      join(dir, 'stubborn.json'),
      JSON.stringify({
        id: 'stubborn',
        mode: 'go',
        args: [],
        pid: 424242,
        started_at: new Date().toISOString(),
        started_by: 'u',
        outcome: 'cancelled',
        finished_at: '2026-09-24T20:05:00.000Z'
      })
    )
    rr.runtime.isOurProcess = () => true
    // Never signal anything real: every kill is answered by the spy.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const s = await rr.cancelRun('stubborn')
      expect(s?.state).toBe('cancelled')
      expect(kill).toHaveBeenCalledWith(-424242, 'SIGTERM')
      expect(JSON.parse(readFileSync(join(dir, 'stubborn.json'), 'utf8')).finished_at).toBe(
        '2026-09-24T20:05:00.000Z'
      )
    } finally {
      kill.mockRestore()
    }
  })

  it('a derived outcome records the log mtime as finished_at', async () => {
    writeFileSync(
      join(dir, 'r11.json'),
      JSON.stringify({
        id: 'r11',
        mode: 'go',
        args: [],
        pid: 999999,
        started_at: '2026-09-24T20:00:00.000Z',
        started_by: 'u'
      })
    )
    writeFileSync(join(dir, 'r11.log'), '### DONE — nivaro 0.1.341\n')
    const when = new Date('2026-09-24T20:07:00.000Z')
    utimesSync(join(dir, 'r11.log'), when, when)
    await rr.listRuns()
    expect(JSON.parse(readFileSync(join(dir, 'r11.json'), 'utf8')).finished_at).toBe(
      when.toISOString()
    )
  })
})

describe('childEnv', () => {
  it('drops NODE_TLS_REJECT_UNAUTHORIZED and pins FORCE_COLOR', () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    try {
      const env = rr.childEnv()
      expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
      expect(env.FORCE_COLOR).toBe('0')
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before
    }
  })
})
