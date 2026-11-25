import { describe, expect, it } from 'vitest'
import {
  extensionDrift,
  flowScriptsLive,
  flowScriptsSetting,
  holdsLatest,
  reapplyWords,
  SHARED_COPY,
  withFlowScripts
} from './shared-api'

describe('shared deployment helpers', () => {
  it('reads the live script switch: on, off, mixed, unknown before 0.3.215 or unreachable', () => {
    const ok = (extra: Record<string, unknown>) =>
      ({
        state: 'ok',
        checked_at: 'x',
        version: '0.3.215',
        instance: 'i',
        registry: { count: 0, loaded_at: null, etag: null, stale: false, dropped: [] },
        apps: [],
        extensions: [],
        oidc: null,
        process: {},
        ...extra
      }) as never
    expect(flowScriptsLive(ok({ flow_scripts: true }))).toBe('on')
    expect(flowScriptsLive(ok({ flow_scripts: false }))).toBe('off')
    expect(flowScriptsLive(ok({ flow_scripts: false, flow_scripts_mixed: true }))).toBe('mixed')
    // A reachable deployment before 0.3.215 does not report it: unknown, never "off" (review L4).
    expect(flowScriptsLive(ok({}))).toBe('unknown')
    expect(
      flowScriptsLive({ state: 'unreachable', code: 'X', message: 'm', checked_at: 'x' })
    ).toBe('unknown')
    expect(flowScriptsLive(undefined)).toBe('unknown')
  })

  it('turns the flow script switch on and off in settings.env, keeping every other setting', () => {
    const base = { size: 'small', env: { CREATE_SCOPE_GUARD: 'on' } }
    expect(flowScriptsSetting(base)).toBe(false)
    expect(flowScriptsSetting({})).toBe(false)
    const on = withFlowScripts(base, true)
    expect(on).toEqual({
      size: 'small',
      env: { CREATE_SCOPE_GUARD: 'on', FLOW_SCRIPTS_ON_SHARED: 'on' }
    })
    expect(flowScriptsSetting(on)).toBe(true)
    expect(withFlowScripts(on, false)).toEqual(base)
    expect(
      withFlowScripts({ size: 'small', env: { FLOW_SCRIPTS_ON_SHARED: 'on' } }, false)
    ).toEqual({
      size: 'small'
    })
  })

  it('says whether a replica holds the latest list, or that it cannot tell', () => {
    const s = { instance: 'w', version: null, etag: '"a"', at: '' }
    expect(holdsLatest(s, '"a"')).toBe(true)
    expect(holdsLatest(s, '"b"')).toBe(false)
    expect(holdsLatest(s, null)).toBeNull()
  })

  it('names loaded extensions that differ from the allow-list, both ways', () => {
    expect(extensionDrift(['a', 'b'], ['b', 'c'])).toEqual({ missing: ['a'], extra: ['c'] })
  })

  it('words the re-apply after a Redis change: applied, busy (next upgrade), last run failed', () => {
    expect(reapplyWords('started', null).tone).toBe('ok')
    expect(reapplyWords('failed', 'BUSY', { version: '0.4.0' }).text).toMatch(
      /move or a placement.*next upgrade.*upgrade to 0\.4\.0/
    )
    expect(reapplyWords('failed', 'LAST_RUN_FAILED').text).toMatch(/last upgrade failed/)
    expect(reapplyWords('unavailable', null).text).toMatch(/next upgrade/)
  })

  it('has plain words for the shared refusals', () => {
    for (const code of ['BAD_SECRETS', 'SHARED_OPERATOR_ONLY', 'SHARED_IN_USE', 'TOKEN_CHANGED'])
      expect(SHARED_COPY[code]?.title, code).toBeTruthy()
  })
})
