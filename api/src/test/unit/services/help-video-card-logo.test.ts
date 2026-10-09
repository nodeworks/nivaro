import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The cards have a logo of their own; the instance logo (sign-in page, admin
// sidebar) is only the fallback and is never written by the help-video panel.
const h = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  columns: new Set<string>(),
  selected: [] as string[]
}))
vi.mock('../../../db/index.js', () => ({
  db: () => ({
    where: () => ({
      first: async (...cols: string[]) => {
        h.selected = cols
        return Object.fromEntries(cols.map((c) => [c, h.row[c]]))
      }
    })
  })
}))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: async (_t: string, c: string) => h.columns.has(c)
}))
vi.mock('../../../services/files.js', () => ({
  getFile: async (id: string) => ({ id, filename_disk: `${id}.svg`, type: 'image/svg+xml' })
}))
vi.mock('../../../services/stored-object-stream.js', () => ({
  openStoredObject: async (disk: string) => ({ stream: Readable.from([Buffer.from(disk)]) })
}))
vi.mock('../../../services/pdf-layout.js', () => ({ getBrowser: async () => null }))

const { loadCardBrand } = await import('../../../services/help-video-cards.js')
const logoOf = (b: { logo: string | null }) =>
  b.logo ? Buffer.from(b.logo.split(',')[1], 'base64').toString() : null

beforeEach(() => {
  h.row = { project_name: 'Acme', project_color: '#00ceff' }
  h.columns = new Set(['help_video_card_logo'])
})

describe('card logo', () => {
  it('uses the cards’ own logo before the instance logo', async () => {
    h.row.brand_logo = 'INSTANCE'
    h.row.help_video_card_logo = 'CARDS'
    expect(logoOf(await loadCardBrand())).toBe('CARDS.svg')
  })
  it('falls back to the instance logo', async () => {
    h.row.brand_logo = 'INSTANCE'
    expect(logoOf(await loadCardBrand())).toBe('INSTANCE.svg')
  })
  it('works on a database without the column yet', async () => {
    h.columns = new Set()
    h.row.brand_logo = 'INSTANCE'
    expect(logoOf(await loadCardBrand())).toBe('INSTANCE.svg')
    expect(h.selected).not.toContain('help_video_card_logo')
  })
})
