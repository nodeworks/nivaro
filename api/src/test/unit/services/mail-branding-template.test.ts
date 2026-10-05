import { describe, expect, it, vi } from 'vitest'

// No DB: template overrides come back empty, the instance branding read fails
// and the stock chrome stands in — exactly a fresh install.
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ select: () => Promise.reject(new Error('no db in test')) }))
}))

import { renderMailTemplate, wrapMailFragment } from '../../../services/mail.js'
import { brandTemplateContext, resolveMailBranding } from '../../../services/mail-branding.js'

const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/\s+/g, ' ')

describe('base.liquid — mail branding per workspace (#1463)', () => {
  it('without a brand the chrome is the stock one: Nivaro, cyan, no logo, no extra footer', async () => {
    const html = await renderMailTemplate('message', { html: '<p>Hello</p>', title: 'Hi' })
    expect(html).toContain('<title>Nivaro</title>')
    expect(html).toContain('Sent by <strong style="color:#334155;">Nivaro</strong>')
    expect(html).toMatch(/id="brand-rule"[^>]*bgcolor="#00ceff"/)
    expect(html).not.toContain('id="brand-logo"')
    expect(html).not.toContain('id="brand-footer"')
  })

  it('a workspace brand lands in the header, the accent rule, the footer name and the footer line', async () => {
    const brand = {
      logo: 'https://cdn.example.com/acme.png',
      color: '#ff6600',
      sender_name: 'Acme <Ops>',
      from_name: 'Acme <Ops>',
      footer: 'Acme Inc · 1 Main St · "quoted"',
      workspace_id: 'ABCDEF01-0000-4000-8000-000000000001'
    }
    // A brand in template DATA is ignored by design (payloads cannot style the
    // chrome); code hands one in through the typed option instead.
    const html = await renderMailTemplate(
      'message',
      { ...brandTemplateContext(brand), html: '<p>Hello</p>' },
      { brand }
    )
    expect(html).toContain('<title>Acme &lt;Ops&gt;</title>')
    expect(html).toMatch(/<img id="brand-logo" src="https:\/\/cdn\.example\.com\/acme\.png"/)
    expect(html).toMatch(/id="brand-rule"[^>]*bgcolor="#ff6600"/)
    expect(html).toMatch(/background-color:#ff6600;border-radius:50%/)
    expect(html).toContain('Sent by <strong style="color:#334155;">Acme &lt;Ops&gt;</strong>')
    expect(html).toMatch(/id="brand-footer"[^>]*>Acme Inc · 1 Main St · &quot;quoted&quot;</)
    // the escaped name never reaches the page as markup
    expect(text(html)).not.toContain('<Ops>')
    // light-only chrome survives the branding
    expect(html).toContain('<meta name="color-scheme" content="light">')
  })

  it('sendRawMail-style wrapping picks the brand up too, and the instance fallback is the stock chrome', async () => {
    const brand = await resolveMailBranding({})
    expect(brand).toMatchObject({
      logo: null,
      color: '#00ceff',
      sender_name: 'Nivaro',
      from_name: null,
      footer: null,
      workspace_id: null
    })
    const html = await wrapMailFragment('<p>Fragment</p>', 'A title')
    expect(html).toContain('<p>Fragment</p>')
    expect(html).toContain('Sent by <strong style="color:#334155;">Nivaro</strong>')
  })
})
