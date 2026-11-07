import { describe, expect, it } from 'vitest'
import { CHART_COLORS } from './ReportView'

const lum = (hex: string) => {
  const c = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// army 8 b14: a 9-state donut showed two pairs of states in one colour and two slices
// near-invisible on the dark page.
describe('report chart colours', () => {
  const hexes = CHART_COLORS.filter((c) => c.startsWith('#'))
  it('ten distinct series colours after the brand', () => {
    expect(CHART_COLORS.length).toBeGreaterThanOrEqual(10)
    expect(new Set(CHART_COLORS).size).toBe(CHART_COLORS.length)
  })
  it('every series colour is ≥3:1 on white, the dark page and dark cards', () => {
    for (const h of hexes) {
      for (const bg of ['#ffffff', '#0d0d0d', '#1e293b'])
        expect(contrast(h, bg), `${h} on ${bg}`).toBeGreaterThanOrEqual(3)
    }
  })
})
