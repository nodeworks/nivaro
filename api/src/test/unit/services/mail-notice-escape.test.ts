import { describe, expect, it, vi } from 'vitest'

// No DB: template overrides come back empty and the stock chrome stands in.
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ select: () => Promise.reject(new Error('no db in test')) }))
}))

import { renderMailTemplate } from '../../../services/mail.js'

// The generic notice carries text people wrote (a viewer's question on a
// help video, #1505, reaches its author this way): it is text, never markup.
describe('notification.liquid — the generic notice escapes what people wrote', () => {
  it('renders markup in the message, the subject and the first name as text', async () => {
    const html = await renderMailTemplate('notification', {
      subject: 'Question on <b>Submitting</b>',
      message: 'At 0:42: <img src=x onerror=alert(1)> <a href="https://evil.example">sign in</a>',
      first_name: '<i>Kim</i>',
      category: 'system'
    })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<a href="https://evil.example">')
    expect(html).not.toContain('<b>Submitting</b>')
    expect(html).not.toContain('<i>Kim</i>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('Question on &lt;b&gt;Submitting&lt;/b&gt;')
    expect(html).toContain('Hi &lt;i&gt;Kim&lt;/i&gt;,')
  })
})
