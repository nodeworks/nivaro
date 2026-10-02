import { describe, expect, it } from 'vitest'
import {
  apiIdOfDown,
  flowRunOfDetail,
  fmtCost,
  fmtDuration,
  hasMask,
  jobStatusNote,
  notFoundWhy,
  outboundApiOf,
  runKindOf,
  runOfDetail,
  statusTone,
  triggerWords,
  writeLabel
} from './logic'

describe('runKindOf / runOfDetail', () => {
  it('names cron and flow sources only', () => {
    expect(runKindOf('cron:staged-imports')).toBe('cron')
    expect(runKindOf('flow:54b4cb84-ebda-420f-8185-eacd4fcd64db')).toBe('flow')
    expect(runKindOf('import:worker')).toBeNull()
    expect(runKindOf('cron:')).toBeNull()
    expect(runKindOf(undefined)).toBeNull()
  })

  it('finds the run a detail carries (top level, event, source, chain step)', () => {
    expect(runOfDetail({ run: 'cron:a' })).toBe('cron:a')
    expect(runOfDetail({ event: { run: 'cron:b' } })).toBe('cron:b')
    expect(runOfDetail({ source: { id: 'cron:c' } })).toBe('cron:c')
    expect(runOfDetail({ chain_parent: 'cron:ext:efp-ops:x' })).toBe('cron:ext:efp-ops:x')
    expect(runOfDetail({ chain_parent: 'request:abc' })).toBeNull()
    expect(runOfDetail(null)).toBeNull()
  })

  it('reads a flow-run chain step exactly', () => {
    expect(flowRunOfDetail({ chain_parent: 'flow_run:54B4CB84-EBDA-420F-8185-EACD4FCD64DB' })).toBe(
      '54b4cb84-ebda-420f-8185-eacd4fcd64db'
    )
    expect(flowRunOfDetail({ chain_parent: 'flow_run:nope' })).toBeNull()
  })
})

describe('partner ids', () => {
  it('maps ext:<id> down nodes to the external API id', () => {
    expect(apiIdOfDown('ext:9')).toBe(9)
    expect(apiIdOfDown('x:efp-ops.mdsi')).toBeNull()
    expect(apiIdOfDown('db')).toBeNull()
  })
  it('reads the partner an event names, ignoring ordinary events', () => {
    expect(outboundApiOf({ extra: { api_id: 4 } })).toBe(4)
    expect(outboundApiOf({ extra: { apiId: '7' } })).toBe(7)
    expect(outboundApiOf({ extra: { down: 'ext:2' } })).toBe(2)
    expect(outboundApiOf({ extra: { storm: true } })).toBeNull()
    expect(outboundApiOf({})).toBeNull()
  })
})

describe('formatting', () => {
  it('durations', () => {
    expect(fmtDuration(13)).toBe('13 ms')
    expect(fmtDuration(2174)).toBe('2.2 s')
    expect(fmtDuration(184_000)).toBe('3 min 4 s')
    expect(fmtDuration(3_720_000)).toBe('1 h 2 min')
    expect(fmtDuration(null)).toBe('—')
  })
  it('costs', () => {
    expect(fmtCost(0.001745)).toBe('$0.0017')
    expect(fmtCost(1.236)).toBe('$1.24')
    expect(fmtCost(0)).toBe('$0')
    expect(fmtCost(null)).toBe('—')
  })
  it('tones', () => {
    expect(statusTone('completed')).toBe('ok')
    expect(statusTone('failed')).toBe('bad')
    expect(statusTone('interrupted')).toBe('warn')
    expect(statusTone('halted here')).toBe('neutral')
  })
  it('words', () => {
    expect(triggerWords('schedule')).toBe('On schedule')
    expect(triggerWords(null)).toMatch(/predates/)
    expect(writeLabel({ action: 'update', collection: 'invoices', item: '12' })).toBe(
      'update invoices 12'
    )
    expect(jobStatusNote({ status: 'interrupted', finished_at: null, error: null })).toMatch(
      /restart or deploy/
    )
    expect(jobStatusNote({ status: 'completed', finished_at: 'x', error: null })).toBeNull()
    expect(notFoundWhy('ai', '5')).toMatch(/30 days/)
    expect(hasMask({ token: '••••••' })).toBe(true)
    expect(hasMask({ a: 1 })).toBe(false)
  })
})
