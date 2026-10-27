// Regenerates api/assets/teams/{color,outline}.png (Nivaro mark: white N; cyan tile for color).
// Run from api/: node ../scripts/make-teams-icons.mjs
import sharp from '../api/node_modules/sharp/lib/index.js'

const N = (size, stroke, fill) => {
  const a = size * 0.28
  const b = size * 0.72
  return `<path d="M${a} ${b} V${a} L${b} ${b} V${a}" fill="none" stroke="${fill}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
}
const color = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" rx="40" fill="#00ceff"/>${N(192, 20, '#ffffff')}</svg>`
const outline = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${N(32, 3, '#ffffff')}</svg>`
await sharp(Buffer.from(color)).png().toFile('api/assets/teams/color.png')
await sharp(Buffer.from(outline)).png().toFile('api/assets/teams/outline.png')
