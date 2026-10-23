import { describe, expect, it } from 'vitest'
import {
  makeSecretTokens,
  mapStrings,
  neutralizeSecretMarkers,
  protectTemplatePlaceholders,
  restrictPlaceholders,
  SECRET_PLACEHOLDER,
  secretPathsOf
} from './secret-markers.js'

const ph = SECRET_PLACEHOLDER('token')
const forged = (s: unknown): boolean => JSON.stringify(s).includes('⟦nvr-secret:')

describe('neutralizeSecretMarkers', () => {
  it('neutralizes literal markers in values and keys', () => {
    const out = neutralizeSecretMarkers({ [ph]: ph, a: [ph, { b: ph }] })
    expect(forged(out)).toBe(false)
    expect(JSON.stringify(out)).toContain('⟦nvr-secret​:token⟧')
  })
  it('walks class instances, keeps Date, leaves Map/Set/Buffer opaque', () => {
    class C {
      x = ph
    }
    const d = new Date(5)
    const set = new Set([ph])
    const m = new Map([['a', ph]])
    const buf = Buffer.from('x')
    const out = neutralizeSecretMarkers({ c: new C(), d, m, s: set, buf }) as any
    expect(out.c).toEqual({ x: '⟦nvr-secret​:token⟧' })
    expect(out.d).toEqual(d)
    expect(out.d).not.toBe(d)
    expect(out.m).toBe(m)
    expect(out.s).toBe(set)
    expect(out.buf).toBe(buf)
  })
  it('keeps cycles and an own __proto__ key', () => {
    const a: any = { v: ph }
    a.self = a
    const out = neutralizeSecretMarkers(a) as any
    expect(out.self).toBe(out)
    const p = JSON.parse(`{"__proto__":{"k":"${ph}"}}`)
    const o = neutralizeSecretMarkers(p) as any
    expect(Object.keys(o)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype)
    expect(o.__proto__.k).toBe('⟦nvr-secret​:token⟧')
  })
  it('mapStrings applies separate key and value functions', () => {
    expect(
      mapStrings(
        { a: 'b' },
        (s) => s.toUpperCase(),
        (k) => `${k}!`
      )
    ).toEqual({ 'a!': 'B' })
  })
})

describe('makeSecretTokens', () => {
  it('turns its tokens into placeholders and neutralizes everything else', () => {
    const t = makeSecretTokens()
    const out = t.finish({
      auth: t.token('token'),
      note: `${ph} and ⟦nvr-secret:x`,
      adj: `⟦nvr-sec${'ret:'}y⟧`,
      list: [`pre-${t.token('b')}-post`]
    }) as any
    expect(out.auth).toBe(ph)
    expect(out.list[0]).toBe(`pre-${SECRET_PLACEHOLDER('b')}-post`)
    expect(out.note.startsWith('⟦nvr-secret​:')).toBe(true)
    expect(out.adj).toContain('​')
    expect([...t.used()].sort()).toEqual(['b', 'token'])
  })
  it('a token in an object key comes back neutral', () => {
    const t = makeSecretTokens()
    const out = t.finish({ [t.token('token')]: 1 }) as any
    expect(Object.keys(out)).toEqual(['⟦nvr-secret​:token⟧'])
    expect(t.used().size).toBe(0)
  })
  it('tokens are per call: another factory leaves them as text', () => {
    const a = makeSecretTokens()
    const b = makeSecretTokens()
    b.token('token')
    const tok = a.token('token')
    expect(b.finish(tok)).toBe(tok)
    expect(b.finish(tok)).not.toContain('⟦nvr-secret:')
  })
})

describe('token shape', () => {
  it('is not a number and a nameless token mints nothing', () => {
    const t = makeSecretTokens()
    expect(Number.isFinite(Number(t.token('x')))).toBe(false)
    expect(t.token(undefined as any)).toBe('')
    expect(t.token('bad name')).toBe('')
    expect(t.token('a.b')).toBe('')
    expect(t.token('x'.repeat(65))).toBe('')
    expect(t.token('ok-name_1')).not.toBe('')
  })
})

describe('protectTemplatePlaceholders', () => {
  const render = (t: string, data: Record<string, string>) =>
    t.replace(/\{(\w+)\}/g, (_m, k) => data[k])
  it('keeps admin placeholders, neutralizes data (literal and JSON-escaped)', () => {
    const p = protectTemplatePlaceholders(`{"t":"${ph}","a":"{a}","b":"{b}"}`)
    const body = p.finish(
      JSON.parse(render(p.text, { a: ph, b: '\\u27e6nvr-secret:token\\u27e7' }))
    ) as any
    expect(body.t).toBe(ph)
    expect(body.a).not.toContain('⟦nvr-secret:')
    expect(body.b).not.toContain('⟦nvr-secret:')
  })
  it('a template placeholder with an invalid name stays inert text', () => {
    const p = protectTemplatePlaceholders('{"a":"⟦nvr-secret:bad name⟧"}')
    expect(JSON.stringify(p.finish(JSON.parse(p.text)))).not.toContain('⟦nvr-secret:')
  })
  it('adjacent interpolations cannot assemble a marker', () => {
    const p = protectTemplatePlaceholders('{"a":"{x}{y}"}')
    const body = p.finish(JSON.parse(render(p.text, { x: '⟦nvr-sec', y: 'ret:token⟧' }))) as any
    expect(body.a).not.toContain('⟦nvr-secret:')
  })
})

describe('secretPathsOf / restrictPlaceholders', () => {
  it('lists and honours only recorded paths; fails closed without a list', () => {
    const body = { a: ph, 'b/c': [ph], d: ph }
    const paths = secretPathsOf({ a: ph, 'b/c': [ph] })
    expect(paths).toEqual(['/a', '/b~1c/0'])
    const out = restrictPlaceholders(body, paths) as any
    expect(out.a).toBe(ph)
    expect(out['b/c'][0]).toBe(ph)
    expect(out.d).not.toContain('⟦nvr-secret:')
    expect(forged(restrictPlaceholders(body, undefined))).toBe(false)
    expect(forged(restrictPlaceholders(body, []))).toBe(false)
  })
})
