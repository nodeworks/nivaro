#!/usr/bin/env node
// Builds the install-as-app icons the web app manifests point at. An installed
// app gets its own Dock / taskbar icon, and its notifications show that icon
// and the app's name instead of the Chrome logo and the site's domain.
//
//   node scripts/app-icons.mjs                                → admin/public/app/
//   node scripts/app-icons.mjs --brand efp --out ../efp-new/public/app
//
// Drawn from each app's own mark (admin: favicon.svg's N; EFP: the lines mark in
// efp-new index.html / src/shell/Logo.tsx — keep them in sync), on the 32-unit
// grid those files use:
//  - icon-192.png, icon-512.png (purpose "any"): the rounded tile inset on a
//    transparent canvas with a soft shadow, the way desktop app icons sit;
//  - maskable-512.png (purpose "maskable"): full-bleed tile, mark inside the
//    80 % safe zone, for launchers that cut their own shape;
//  - apple-touch-icon.png (180): full-bleed, iOS rounds it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sharp = createRequire(join(root, 'api/package.json'))('sharp')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const brand = arg('brand', 'nivaro')
const out = resolve(arg('out', join(root, 'admin/public/app')))

const BRANDS = {
  nivaro: {
    defs: '',
    fill: '#172940',
    // favicon.svg's N runs edge to edge (and its miter tips past it): fine at
    // 32 px, cramped as an app icon — inset it.
    inset: 0.62,
    mark: `<polyline points="7,26 7,6 23,26 23,6" fill="none" stroke="#00ceff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="miter"/>`
  },
  efp: {
    defs: `<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#182742"/><stop offset="1" stop-color="#0b1526"/></linearGradient><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="9" x2="0" y2="23"><stop offset="0" stop-color="#7ae9ff"/><stop offset="1" stop-color="#00b9e8"/></linearGradient>`,
    fill: 'url(#t)',
    inset: 1,
    mark: `<path d="M10.5 10.5h11M10.5 16h6.5M10.5 21.5h11" fill="none" stroke="url(#g)" stroke-width="3" stroke-linecap="round"/><circle cx="21.5" cy="16" r="1.6" fill="#7ae9ff"/>`
  }
}
const b = BRANDS[brand]
if (!b) throw new Error(`unknown brand ${brand}`)
const mark = `<g transform="translate(16 16) scale(${b.inset}) translate(-16 -16)">${b.mark}</g>`

/** Rounded tile inset at 80 % (desktop icon grid), soft shadow below it. */
function anySvg() {
  const inset = 100
  const size = 824
  const s = size / 32
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${b.defs}<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#0b1526" flood-opacity="0.32"/></filter></defs><g filter="url(#sh)"><rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${size * 0.225}" fill="${b.fill}"/></g><g transform="translate(${inset} ${inset}) scale(${s})">${mark}</g></svg>`
}

/** Full-bleed tile; the mark (which fills ~70 % of its 32 grid) shrunk into the safe zone. */
function fullSvg() {
  const k = 0.78
  const s = (1024 / 32) * k
  const off = (1024 - 1024 * k) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${b.defs}</defs><rect width="1024" height="1024" fill="${b.fill === 'url(#t)' ? '#11203a' : b.fill}"/>${b.fill === 'url(#t)' ? '<g transform="scale(32)"><rect width="32" height="32" fill="url(#t)"/></g>' : ''}<g transform="translate(${off} ${off}) scale(${s})">${mark}</g></svg>`
}

async function png(svg, size, file) {
  const buf = await sharp(Buffer.from(svg), { density: 144 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer()
  writeFileSync(join(out, file), buf)
  return buf.length
}

mkdirSync(out, { recursive: true })
let total = 0
total += await png(anySvg(), 192, 'icon-192.png')
total += await png(anySvg(), 512, 'icon-512.png')
total += await png(fullSvg(), 512, 'maskable-512.png')
total += await png(fullSvg(), 180, 'apple-touch-icon.png')
console.log(`4 app icons (${brand}) → ${out}, ${Math.round(total / 1024)} KB`)
