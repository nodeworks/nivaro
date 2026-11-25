// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyHubProduct,
  defaultAccentFor,
  HUB_ACCENT,
  HUB_ICONS,
  HUB_PRODUCT_KEY,
  hubProductOn,
  isHubProduct,
  readableOn
} from './hub-product'

const INDEX = readFileSync(join(import.meta.dirname, '../../index.html'), 'utf8')

/** The <head> of the real admin index.html, scripts left out (the boot script is run below). */
function loadHead() {
  const head = INDEX.slice(INDEX.indexOf('<head>') + 6, INDEX.indexOf('</head>'))
  document.head.innerHTML = head.replace(/<script>[\s\S]*?<\/script>/g, '')
  document.documentElement.removeAttribute('data-product')
  document.title = 'Nivaro'
}

/** Runs index.html's inline boot script as the browser would, before the app. */
function runBootScript() {
  const m = /<script>([\s\S]*?)<\/script>/.exec(INDEX)
  if (!m) throw new Error('no boot script in index.html')
  new Function(m[1])()
}

const iconHref = () => document.querySelector('link[rel~="icon"]')?.getAttribute('href')
const manifestHref = () => document.querySelector('link[rel="manifest"]')?.getAttribute('href')
const touchHref = () => document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')

beforeEach(() => {
  // Back to a regular page (the product label of the tab title lives in a module).
  applyHubProduct(false)
  localStorage.clear()
  loadHead()
})
afterEach(() => {
  applyHubProduct(false)
  localStorage.clear()
})

describe('hub_only flag → data-product', () => {
  it('reads hub_only from the feature list', () => {
    expect(isHubProduct(['hub', 'hub_only'])).toBe(true)
    expect(isHubProduct(['hub'])).toBe(false)
    expect(isHubProduct(undefined)).toBe(false)
  })

  it('on: sets data-product, swaps icon/manifest/apple-touch, remembers it', () => {
    applyHubProduct(true)
    expect(hubProductOn()).toBe(true)
    expect(document.documentElement.getAttribute('data-product')).toBe('hub')
    expect(iconHref()).toBe(HUB_ICONS.svg)
    expect(manifestHref()).toBe(HUB_ICONS.manifest)
    expect(touchHref()).toBe(HUB_ICONS.appleTouch)
    expect(document.querySelectorAll('link[data-hub-icon]')).toHaveLength(2)
    expect(localStorage.getItem(HUB_PRODUCT_KEY)).toBe('hub')
  })

  it('off after on: everything back to Nivaro exactly', () => {
    const before = document.head.innerHTML
    applyHubProduct(true)
    applyHubProduct(false)
    expect(hubProductOn()).toBe(false)
    expect(document.documentElement.hasAttribute('data-product')).toBe(false)
    expect(document.head.innerHTML).toBe(before)
    expect(localStorage.getItem(HUB_PRODUCT_KEY)).toBeNull()
  })

  it('off on a regular install changes nothing at all', () => {
    const before = document.head.innerHTML
    applyHubProduct(false)
    expect(document.head.innerHTML).toBe(before)
    expect(document.documentElement.hasAttribute('data-product')).toBe(false)
    expect(iconHref()).toBe('/favicon.svg')
    expect(manifestHref()).toBe('/manifest.webmanifest')
    expect(touchHref()).toBe('/app/apple-touch-icon.png')
  })
})

describe('index.html boot script (no flash on a standalone Hub)', () => {
  it('a browser that never saw a Hub keeps the Nivaro icon, manifest and title', () => {
    const before = document.head.innerHTML
    runBootScript()
    expect(document.head.innerHTML).toBe(before)
    expect(document.title).toBe('Nivaro')
    expect(hubProductOn()).toBe(false)
  })

  it('after a Hub answer, the next load starts in Hub mode before the app runs', () => {
    localStorage.setItem(HUB_PRODUCT_KEY, 'hub')
    runBootScript()
    expect(hubProductOn()).toBe(true)
    expect(document.title).toBe('Nivaro Hub')
    expect(iconHref()).toBe(HUB_ICONS.svg)
    expect(manifestHref()).toBe(HUB_ICONS.manifest)
    expect(touchHref()).toBe(HUB_ICONS.appleTouch)
    // …and app-info saying "not a Hub" puts every link back.
    applyHubProduct(false)
    expect(iconHref()).toBe('/favicon.svg')
    expect(manifestHref()).toBe('/manifest.webmanifest')
    expect(touchHref()).toBe('/app/apple-touch-icon.png')
  })
})

describe('accent', () => {
  it('regular install: exactly the old chain (chosen colour, else stock cyan)', () => {
    expect(defaultAccentFor(false, null)).toBe('#00ceff')
    expect(defaultAccentFor(false, '#123456')).toBe('#123456')
    expect(defaultAccentFor(false, '#00CEFF')).toBe('#00CEFF')
  })

  it('Hub: amber unless an operator chose a colour (stock cyan counts as none)', () => {
    expect(defaultAccentFor(true, null)).toBe(HUB_ACCENT)
    expect(defaultAccentFor(true, '#00CEFF')).toBe(HUB_ACCENT)
    expect(defaultAccentFor(true, '#123456')).toBe('#123456')
  })

  it('ink on the accent passes AA: dark on amber, white on navy', () => {
    expect(readableOn(HUB_ACCENT)).toBe('#14110a')
    expect(readableOn('#172940')).toBe('#ffffff')
  })
})
