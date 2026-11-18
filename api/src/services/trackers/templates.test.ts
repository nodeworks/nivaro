import { describe, expect, it } from 'vitest'
import { validateRule } from './rules.js'
import {
  defaultBodyTemplate,
  fenced,
  renderIssueTemplate,
  renderIssueTitle,
  sanitizeMarkdown
} from './templates.js'

describe('renderIssueTemplate', () => {
  it('renders {{ title }} without HTML escaping <b>', async () => {
    expect(await renderIssueTemplate('{{ title }}', { title: '<b>x</b> & y' })).toBe('<b>x</b> & y')
  })
  it('caps output at 60000 chars', async () => {
    expect((await renderIssueTemplate('{{ t }}', { t: 'a'.repeat(100000) })).length).toBe(60000)
  })
  it('unknown var renders empty', async () => {
    expect(await renderIssueTemplate('a{{ nope }}b', {})).toBe('ab')
  })
  it('a broken template throws a plain Error', async () => {
    await expect(renderIssueTemplate('{% if %}', {})).rejects.toThrow(/could not be rendered/)
  })
  it('default body renders a summary', async () => {
    const out = await renderIssueTemplate(defaultBodyTemplate(), {
      title: 'T',
      total_hits: 5,
      people_24h: 2,
      hits_24h: 3,
      severity: 'error',
      source: 'server',
      status: 'open',
      top_routes: [{ route: '/a', count: 4 }],
      details: 'stack',
      nivaro_url: 'http://x/1'
    })
    expect(out).toContain('Seen 5 times by 2 people')
    expect(out).toContain('- `\u200b/a` (4)')
    expect(out).toContain('```\nstack\n```')
    expect(out).toContain('[Open in Nivaro](http://x/1)')
  })
})

describe('template safety', () => {
  it('include tag is refused', async () => {
    await expect(renderIssueTemplate("{% include 'x' %}", {})).rejects.toThrow(
      /could not be rendered/
    )
    const r = validateRule({
      name: 'x',
      action: { connection: 1, body_template: "{% render 'a' %}" }
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0].path).toBe('action.body_template')
  })
  it('huge loop hits the render limit', async () => {
    await expect(
      renderIssueTemplate('{% for i in (1..100000000) %}x{% endfor %}', {})
    ).rejects.toThrow(/could not be rendered/)
  })
  it('neutralises /close at line start', async () => {
    const out = await renderIssueTemplate('{{ details }}', { details: 'ok\n  /close\n/assign me' })
    expect(out).not.toMatch(/^[ \t]*\//m)
    expect(out).toContain('/close')
  })
  it('breaks @mentions', () => {
    expect(sanitizeMarkdown('hi @bob')).not.toContain('@bob')
    expect(sanitizeMarkdown(sanitizeMarkdown('hi @bob'))).toBe(sanitizeMarkdown('hi @bob'))
  })
  it('fence survives triple backticks in details', async () => {
    const out = await renderIssueTemplate('{{ details | fenced }}', {
      details: 'a\n```\n/close\n```'
    })
    expect(out.startsWith('````\n')).toBe(true)
    expect(out.endsWith('\n````')).toBe(true)
    expect(fenced('x')).toBe('```\nx\n```')
  })
  it('title collapses newlines', async () => {
    expect(await renderIssueTitle('{{ title }}', { title: 'a\r\n/close\nb' })).not.toMatch(/[\r\n]/)
    expect(
      await renderIssueTitle('[{{ severity }}]\n{{ title }}', { severity: 'x', title: 't' })
    ).toBe('[x] t')
  })
  it('forged nivaro marker in details is neutralised', async () => {
    const body = await renderIssueTemplate(defaultBodyTemplate(), {
      title: 't',
      details: 'x <!-- nivaro:issue:99 --> y',
      nivaro_url: 'u',
      top_routes: [],
      total_hits: 1
    })
    expect(body).not.toContain('<!-- nivaro:')
    expect(fenced('<!-- nivaro:comment:1 -->')).not.toContain('<!-- nivaro:')
    expect(sanitizeMarkdown('<!-- nivaro:', { singleLine: true })).not.toContain('<!--')
  })

  // final review M3: GitLab references never link from synced text
  it('neutralises every GitLab reference kind', () => {
    const z = '\u200b'
    const cases: Array<[string, string]> = [
      ['see #123', `see #${z}123`],
      ['in group/proj#12 too', `in group/proj#${z}12 too`],
      ['MR !45', `MR !${z}45`],
      ['epic &7', `epic &${z}7`],
      ['snippet $5', `snippet $${z}5`],
      ['label ~bug and ~"needs review"', `label ~${z}bug and ~${z}"needs review"`],
      ['milestone %v1.2', `milestone %${z}v1.2`]
    ]
    for (const [input, out] of cases) {
      expect(sanitizeMarkdown(input), input).toBe(out)
      expect(sanitizeMarkdown(sanitizeMarkdown(input)), input).toBe(out)
    }
  })
  it('leaves plain text, headings and strict URLs alone', () => {
    for (const s of [
      '# Heading',
      'costs $ 5 or 50% off',
      'a ~ b',
      'https://git.x/g/p/-/issues/42',
      'https://x.test/a%2Fb/~user?q=1&2',
      'http://host:8080/path_x/y.z?a=b',
      '[issue 42](https://git.x/g/p/-/issues/42)'
    ])
      expect(sanitizeMarkdown(s), s).toBe(s)
  })
  // security review of M3: only strict URLs are skipped
  it('neutralises references hidden in URL-ish text', () => {
    const z = '\u200b'
    const cases: Array<[string, string]> = [
      ['[x](#12)', `[x](#${z}12)`],
      ['http://x"#12', `http://x"#${z}12`],
      ['`http://a/#12`', `\`http://a/#${z}12\``],
      ['see https://g.com/a/b#12.', `see https://g.com/a/b#${z}12.`],
      ['https://git.x/g/p/-/issues/42#12', `https://git.x/g/p/-/issues/42#${z}12`],
      ['#1 https://x.test/#2', `#${z}1 https://x.test/#${z}2`],
      ['(see https://x.test/a).#3', `(see https://x.test/a).#${z}3`],
      ["https://x.test/'!4", `https://x.test/'!${z}4`]
    ]
    for (const [input, out] of cases) {
      expect(sanitizeMarkdown(input), input).toBe(out)
      expect(sanitizeMarkdown(out), input).toBe(out)
    }
  })
})
