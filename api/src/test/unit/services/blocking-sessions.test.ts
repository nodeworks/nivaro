import { describe, expect, it } from 'vitest'
import {
  type BlockedRequest,
  type ChainSession,
  summarizeBlocking
} from '../../../services/blocking-sessions.js'

const req = (
  session_id: number,
  blocking_session_id: number,
  seconds: number,
  mine: boolean,
  database_name = mine ? 'App' : 'Other'
): BlockedRequest => ({
  session_id,
  blocking_session_id,
  wait_time: seconds * 1000,
  wait_type: 'LCK_M_S',
  mine,
  database_name,
  sql_text: `select ${session_id}`
})

const ses = (
  session_id: number,
  mine: boolean,
  extra: Partial<ChainSession> = {}
): ChainSession => ({
  session_id,
  mine,
  database_name: mine ? 'App' : 'Other',
  program_name: mine ? 'nivaro-api' : 'php',
  host_name: 'host',
  login_name: mine ? 'app_login' : 'other_login',
  open_transaction_count: 0,
  sql_text: null,
  ...extra
})

describe('summarizeBlocking', () => {
  it('says nothing about a chain that is wholly in another database on the same server', () => {
    // Production 2026-11-12: another application's replication snapshot held 23 of ITS
    // sessions for 335 s; this app was untouched and raised a critical issue four times.
    const requests = [req(71, 70, 335, false), req(72, 70, 300, false), req(73, 72, 200, false)]
    const sessions = [ses(70, false), ses(71, false), ses(72, false), ses(73, false)]
    expect(summarizeBlocking(requests, sessions)).toBeNull()
  })

  it('reports a chain that touches this database, and only that chain', () => {
    const requests = [
      req(11, 10, 40, true),
      // A second, unrelated chain in another database at the same moment.
      req(71, 70, 335, false),
      req(72, 70, 300, false)
    ]
    const sessions = [
      ses(10, true, { sql_text: 'update t set a = 1', open_transaction_count: 1 }),
      ses(11, true),
      ses(70, false),
      ses(71, false),
      ses(72, false)
    ]
    const r = summarizeBlocking(requests, sessions)
    expect(r?.message).toBe('1 session(s) blocked (worst 40s) behind 1 head blocker(s)')
    expect(r?.severity).toBe('high')
    expect(r?.stack).toContain('#10')
    expect(r?.stack).toContain('update t set a = 1')
    expect(r?.stack).not.toContain('#70')
    expect(r?.stack).not.toContain('#71')
  })

  it('reports a chain whose head is elsewhere but which holds up a session of this database', () => {
    const requests = [req(11, 70, 130, true)]
    const sessions = [ses(70, false, { sql_text: 'alter index all on big rebuild' }), ses(11, true)]
    const r = summarizeBlocking(requests, sessions)
    expect(r?.message).toBe('1 session(s) blocked (worst 130s) behind 1 head blocker(s)')
    expect(r?.severity).toBe('critical')
    expect(r?.stack).toContain('Other')
    expect(r?.stack).toContain('php')
  })

  it("keeps another database's statement, login and host out of the report", () => {
    // The head belongs to another application: its SQL text can carry that application's
    // data, and its login and host are not this app's to store. Where it is and what
    // program it is are enough to know whom to call.
    const requests = [req(11, 70, 130, true)]
    const sessions = [
      ses(70, false, {
        sql_text: "update customers set ssn = '123-45-6789' where id = 7",
        host_name: 'their-host',
        login_name: 'their_login',
        open_transaction_count: 1
      }),
      ses(11, true)
    ]
    const r = summarizeBlocking(requests, sessions)
    expect(r?.stack).toContain('#70 [Other · php]')
    expect(r?.stack).toContain('1 open transaction(s)')
    expect(r?.stack).not.toContain('ssn')
    expect(r?.stack).not.toContain('their_login')
    expect(r?.stack).not.toContain('their-host')
  })

  it('counts as head blockers only the sessions nobody else is blocking', () => {
    // 10 blocks 11, 11 blocks 12 and 13: one head (10), not two.
    const requests = [req(11, 10, 60, true), req(12, 11, 50, true), req(13, 11, 45, true)]
    const sessions = [ses(10, true), ses(11, true), ses(12, true), ses(13, true)]
    const r = summarizeBlocking(requests, sessions)
    expect(r?.message).toBe('3 session(s) blocked (worst 60s) behind 1 head blocker(s)')
  })

  it('names an idle head by its last statement and its open transaction', () => {
    const requests = [req(11, 10, 30, true)]
    const sessions = [
      ses(10, true, { sql_text: 'select * from orders', open_transaction_count: 2 }),
      ses(11, true)
    ]
    const r = summarizeBlocking(requests, sessions)
    expect(r?.stack).toContain('select * from orders')
    expect(r?.stack).toContain('2 open transaction(s)')
  })

  it('stays quiet while nothing in the chain has waited 15 seconds', () => {
    const requests = [req(11, 10, 14, true)]
    expect(summarizeBlocking(requests, [ses(10, true), ses(11, true)])).toBeNull()
  })
})
