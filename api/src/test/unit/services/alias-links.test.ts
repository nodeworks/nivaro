import { describe, expect, it } from 'vitest'
import { dedupeAliasLinks, sameAliasLink } from '../../../services/alias-links.js'

// army 10 item 3: IR 37827's Ship-To Contact read "Peter Moniz, Peter Moniz".
// The BOM header prefill and the person's own pick both named him — once
// upper-case (the stored uniqueidentifier), once lower-case (the lookup) —
// and the junction write compared the raw strings, so two rows landed.
describe('alias link identity', () => {
  const upper = { id: '46A4897B-3F11-4DAE-BC1D-C2C0517ABBC6', collection: 'directus_users' }
  const lower = { id: '46a4897b-3f11-4dae-bc1d-c2c0517abbc6', collection: 'directus_users' }

  it('the same id in another letter case is the same link', () => {
    expect(sameAliasLink(upper, lower)).toBe(true)
    expect(sameAliasLink(upper, { ...lower, collection: 'Directus_Users' })).toBe(true)
  })

  it('a stored link with no discriminator matches any collection', () => {
    expect(sameAliasLink({ id: upper.id }, lower)).toBe(true)
  })

  it('another person or another collection is another link', () => {
    expect(sameAliasLink(upper, { ...upper, id: '23AEA8DF-96C2-405C-B632-F676DF983F3B' })).toBe(
      false
    )
    expect(sameAliasLink(upper, { ...upper, collection: 'vendors' })).toBe(false)
  })

  it('numeric ids compare by value as strings', () => {
    expect(sameAliasLink({ id: 7 }, { id: '7' })).toBe(true)
    expect(sameAliasLink({ id: 7 }, { id: 70 })).toBe(false)
  })
})

describe('dedupeAliasLinks', () => {
  it('one write naming a person twice links them once, first spelling kept', () => {
    const out = dedupeAliasLinks([
      { id: '46A4897B-3F11-4DAE-BC1D-C2C0517ABBC6', collection: 'directus_users' },
      { id: '46a4897b-3f11-4dae-bc1d-c2c0517abbc6', collection: 'directus_users' },
      { id: '23AEA8DF-96C2-405C-B632-F676DF983F3B', collection: 'directus_users' }
    ])
    expect(out.map((l) => l.id)).toEqual([
      '46A4897B-3F11-4DAE-BC1D-C2C0517ABBC6',
      '23AEA8DF-96C2-405C-B632-F676DF983F3B'
    ])
  })

  it('keeps distinct links in order', () => {
    const links = [{ id: 3 }, { id: 1 }, { id: 2 }]
    expect(dedupeAliasLinks(links)).toEqual(links)
  })
})
