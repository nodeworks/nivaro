#!/usr/bin/env node
// Builds the raster icons browser notifications show (Chrome draws no SVG in a
// notification, so the old /favicon.svg icon fell back to a bare Chrome logo).
//
//   node scripts/push-icons.mjs                       → admin/public/push/
//   node scripts/push-icons.mjs --brand efp --out ../efp-new/public/push
//
// One 192 px icon per notification category and lane: the app's own tile with
// the category's glyph (lucide, the icon set the apps use), plus a corner dot
// for the lane — amber = needs you, red = critical, none = FYI. Also a 96 px
// white-on-transparent badge for Android's status bar. Commit the output; the
// service workers read `/push/<category>[-needs|-critical].png` and
// `/push/badge.png`, and fall back to `/push/default*.png` for an unknown
// category. Category keys match PUSH_ICON_CATEGORIES in api/src/services/web-push.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sharp = createRequire(join(root, 'api/package.json'))('sharp')
const lucideDir = join(root, 'admin/node_modules/lucide-react/dist/esm/icons')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const brand = arg('brand', 'nivaro')
const out = resolve(arg('out', join(root, 'admin/public/push')))

/** Category → lucide icon file. `default` is the app's own mark. */
const GLYPHS = {
  workflow: 'workflow',
  approvals: 'circle-check',
  tasks: 'list-checks',
  mentions: 'at-sign',
  watch: 'eye',
  alerts: 'bell',
  anomaly: 'activity',
  sla: 'clock',
  reports: 'chart-column',
  integrations: 'plug',
  system: 'settings',
  security: 'shield-alert',
  chat: 'message-square',
  huddle: 'headphones',
  chaos: 'zap'
}

const LANES = { fyi: null, needs: '#f59e0b', critical: '#ef4444' }

const BRANDS = {
  nivaro: {
    tile: `<rect width="192" height="192" rx="42" fill="#172940"/>`,
    ink: '#00ceff',
    defs: '',
    ring: '#172940',
    // The favicon's N, drawn on the 24-unit glyph grid.
    mark: (stroke) =>
      `<polyline points="5.25,19.5 5.25,4.5 18.75,19.5 18.75,4.5" fill="none" stroke="${stroke}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="miter"/>`
  },
  efp: {
    tile: `<rect width="192" height="192" rx="48" fill="url(#t)"/>`,
    ink: 'url(#g)',
    defs: `<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#182742"/><stop offset="1" stop-color="#0b1526"/></linearGradient><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="22"><stop offset="0" stop-color="#7ae9ff"/><stop offset="1" stop-color="#00b9e8"/></linearGradient>`,
    ring: '#101d33',
    // `g` is in the glyph's own 24-unit space (userSpaceOnUse): a bounding-box
    // gradient paints nothing on a perfectly straight line (zero-height box).
    // push-icon.svg's three lines + dot, on the 24-unit glyph grid.
    mark: (stroke) =>
      `<path d="M4.5 4.5h15M4.5 12h8.9M4.5 19.5h15" fill="none" stroke="${stroke}" stroke-width="4.1" stroke-linecap="round"/><circle cx="19.5" cy="12" r="2.2" fill="${stroke === 'url(#g)' ? '#7ae9ff' : stroke}"/>`
  }
}

const b = BRANDS[brand]
if (!b) throw new Error(`unknown brand ${brand}`)

/** lucide's __iconNode array → SVG elements, stroked in `stroke`. */
function lucideElements(name, stroke) {
  const src = readFileSync(join(lucideDir, `${name}.js`), 'utf8')
  const m = src.match(/const __iconNode = (\[[\s\S]*?\]);\n/)
  if (!m) throw new Error(`no __iconNode in ${name}`)
  // biome-ignore lint/security/noGlobalEval: trusted vendored icon data
  const nodes = (0, eval)(m[1])
  return nodes
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${v}"`)
        .join(' ')
      return `<${tag} ${a}/>`
    })
    .join('')
    .replace(/^/, `<g fill="none" stroke="${stroke}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">`)
    .concat('</g>')
}

/** The glyph on a 24-unit grid, placed in the middle 108 px of a 192 tile. */
function glyph(category, stroke) {
  const inner = category === 'default' ? b.mark(stroke) : lucideElements(GLYPHS[category], stroke)
  return `<g transform="translate(42 42) scale(4.5)">${inner}</g>`
}

function iconSvg(category, laneColor) {
  const dot = laneColor
    ? `<circle cx="158" cy="34" r="27" fill="${b.ring}"/><circle cx="158" cy="34" r="19" fill="${laneColor}"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><defs>${b.defs}</defs>${b.tile}${glyph(category, b.ink)}${dot}</svg>`
}

function badgeSvg() {
  // Android tints the badge itself: only its alpha counts.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><g transform="translate(12 12) scale(3)">${b.mark('#ffffff')}</g></svg>`
}

async function png(svg, file) {
  const buf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toBuffer()
  writeFileSync(join(out, file), buf)
  return buf.length
}

mkdirSync(out, { recursive: true })
let total = 0
let count = 0
for (const category of ['default', ...Object.keys(GLYPHS)]) {
  for (const [lane, color] of Object.entries(LANES)) {
    total += await png(iconSvg(category, color), `${category}${lane === 'fyi' ? '' : `-${lane}`}.png`)
    count++
  }
}
total += await png(badgeSvg(), 'badge.png')
count++
console.log(`${count} icons (${brand}) → ${out}, ${Math.round(total / 1024)} KB`)
