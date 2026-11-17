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
})
