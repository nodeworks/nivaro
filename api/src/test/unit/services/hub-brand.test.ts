import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// No DB: mail template overrides come back empty (a fresh install).
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ select: () => Promise.reject(new Error('no db in test')) }))
}))

import {
  HUB_BRAND,
  hubIndexHtml,
  hubStandaloneCached,
  inkOn,
  isStockProjectName,
  resetHubBrandCache
} from '../../../services/hub/brand.js'
import {
  HUB_MAIL_ACCENT,
  hubMailBrand,
  mailChrome,
  registerMailTemplateRoot,
  safeHtml
} from '../../../services/mail.js'
import { brandTemplateContext, type MailBrand } from '../../../services/mail-branding.js'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../../..')
const ADMIN_INDEX = readFileSync(join(ROOT, 'admin/index.html'), 'utf8')

const stock: MailBrand = {
  logo: null,
  color: '#00ceff',
  sender_name: 'Nivaro',
  from_name: null,
  footer: null,
  workspace_id: null
}

afterEach(() => resetHubBrandCache())

describe('standalone Hub index.html (served before any script runs)', () => {
  it('swaps the icon, manifest, apple-touch icon and title, and marks <html>', () => {
    const out = hubIndexHtml(ADMIN_INDEX)
    expect(out).toMatch(/<html data-product="hub" lang="en">/)
    expect(out).toContain(`href="${HUB_BRAND.favicon}" data-nvr-base-icon="/favicon.svg"`)
    expect(out).toContain(`href="${HUB_BRAND.favicon32}"`)
    expect(out).toContain(`href="${HUB_BRAND.favicon16}"`)
    expect(out).toContain(
      `<link rel="manifest" href="${HUB_BRAND.manifest}" data-nvr-base-href="/manifest.webmanifest"`
    )
    expect(out).toContain(`href="${HUB_BRAND.appleTouch}"`)
    expect(out).toContain('<title>Nivaro Hub</title>')
    // The Nivaro icon is kept only as the way back (data-nvr-base-*), never as an active href.
    expect(out).not.toMatch(/href="\/favicon\.svg"/)
  })

  it('the regular index.html itself still points at the Nivaro icon, manifest and title', () => {
    expect(ADMIN_INDEX).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    expect(ADMIN_INDEX).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(ADMIN_INDEX).toContain('<title>Nivaro</title>')
    expect(ADMIN_INDEX).not.toContain('data-product="hub"')
  })

  it('is kept 60 s, and off at once without HUB=on', async () => {
    let reads = 0
    const read = async () => {
      reads++
      return true
    }
    expect(await hubStandaloneCached({ read, now: 1000 })).toBe(true)
    expect(await hubStandaloneCached({ read, now: 50_000 })).toBe(true)
    expect(reads).toBe(1)
    expect(await hubStandaloneCached({ read, now: 62_000 })).toBe(true)
    expect(reads).toBe(2)
    resetHubBrandCache()
    expect(await hubStandaloneCached({ env: {} })).toBe(false)
  })

  it('a failed read keeps the last known answer (the look never flips on a blip)', async () => {
    expect(await hubStandaloneCached({ read: async () => true, now: 1000 })).toBe(true)
    const boom = async (): Promise<boolean> => {
      throw new Error('db down')
    }
    expect(await hubStandaloneCached({ read: boom, now: 70_000 })).toBe(true)
    resetHubBrandCache()
    expect(await hubStandaloneCached({ read: boom, now: 1 })).toBe(false)
  })

  it('names nobody chose: empty, Nivaro, the database default Nivaro CMS', () => {
    for (const n of [null, '', ' Nivaro ', 'Nivaro CMS', 'nivaro cms'])
      expect(isStockProjectName(n)).toBe(true)
    expect(isStockProjectName('Acme Ops')).toBe(false)
  })
})

describe('Hub mail chrome', () => {
  it('a regular install keeps the stock brand and engine', async () => {
    const chrome = await mailChrome(stock, { standalone: async () => false })
    expect(chrome.hub).toBe(false)
    expect(chrome.brand).toBe(stock)
  })

  it('a standalone Hub sends as "Nivaro Hub" with the Hub mark and amber rule', async () => {
    const chrome = await mailChrome(stock, {
      standalone: async () => true,
      markUrl: async () => 'https://hub.example.com/hub-brand/mail-mark.png'
    })
    expect(chrome.hub).toBe(true)
    expect(chrome.brand.from_name).toBe('Nivaro Hub')
    expect(chrome.brand.sender_name).toBe('Nivaro Hub')
    expect(chrome.brand.color).toBe(HUB_MAIL_ACCENT)
    expect(chrome.brand.logo).toBe('https://hub.example.com/hub-brand/mail-mark.png')
    const html = await chrome.engine.renderFile('message', {
      ...brandTemplateContext(chrome.brand),
      title: 'Promotion finished',
      html: safeHtml('<p>efp production runs 0.3.215</p>')
    })
    expect(html).toContain('data-hub-mail')
    expect(html).toContain('background-color:#0d1726')
    expect(html).toContain('efp production runs 0.3.215')
  })

  it('"Nivaro CMS" (the database default) also gives way to Nivaro Hub in the chrome', () => {
    const b = hubMailBrand({ ...stock, sender_name: 'Nivaro CMS' }, null)
    expect(b.sender_name).toBe('Nivaro Hub')
  })

  it('the HUB badge ink follows the colour by contrast (a dark operator colour gets white)', async () => {
    const amber = await mailChrome(stock, {
      standalone: async () => true,
      markUrl: async () => null
    })
    expect(amber.extra.hub_badge_ink).toBe('#14110a')
    const navy = await mailChrome(
      { ...stock, color: '#172940' },
      { standalone: async () => true, markUrl: async () => null }
    )
    expect(navy.extra.hub_badge_ink).toBe('#ffffff')
    expect(inkOn('#172940')).toBe('#ffffff')
    const html = await navy.engine.renderFile('message', {
      ...brandTemplateContext(navy.brand),
      ...navy.extra,
      html: safeHtml('<p>x</p>')
    })
    expect(html).toContain('color:#ffffff;background-color:#172940')
  })

  it("an operator's own logo, sender name and colour win over the Hub defaults", () => {
    const own: MailBrand = {
      ...stock,
      logo: 'https://cdn.example.com/acme.png',
      color: '#123456',
      sender_name: 'Acme Ops',
      from_name: 'Acme Ops'
    }
    const b = hubMailBrand(own, 'https://hub.example.com/hub-brand/mail-mark.png')
    expect(b.logo).toBe('https://cdn.example.com/acme.png')
    expect(b.color).toBe('#123456')
    expect(b.sender_name).toBe('Acme Ops')
    expect(b.from_name).toBe('Acme Ops')
  })

  it('a failing standalone read keeps the stock chrome', async () => {
    const chrome = await mailChrome(stock, {
      standalone: async () => {
        throw new Error('db down')
      }
    })
    expect(chrome.hub).toBe(false)
  })
})

describe('Hub mail template order', () => {
  it("an extension's own base.liquid still wins over the Hub layout", async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'hub-mail-ext-'))
    writeFileSync(join(dir, 'base.liquid'), 'EXT-BASE {% block content %}{% endblock %}')
    registerMailTemplateRoot(dir)
    const chrome = await mailChrome(stock, {
      standalone: async () => true,
      markUrl: async () => null
    })
    const html = await chrome.engine.renderFile('message', {
      ...brandTemplateContext(chrome.brand),
      html: safeHtml('<p>body</p>')
    })
    expect(html).toContain('EXT-BASE')
    expect(html).not.toContain('data-hub-mail')
  })
})
