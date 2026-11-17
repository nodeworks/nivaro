import { describe, expect, it } from 'vitest'
import { defaultBodyTemplate, renderIssueTemplate } from './templates.js'

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
    expect(out).toContain('- `/a` (4)')
    expect(out).toContain('```\nstack\n```')
    expect(out).toContain('[Open in Nivaro](http://x/1)')
  })
})
