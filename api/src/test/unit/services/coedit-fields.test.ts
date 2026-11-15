import { describe, expect, it } from 'vitest'
import { onlySharedText, sharedTextFieldRow } from '../../../services/coedit-fields.js'
import type { CMSField } from '../../../types.js'

const field = (over: Record<string, unknown>): CMSField =>
  ({
    field: 'notes',
    type: 'text',
    interface: 'input-rich-text-html',
    special: null,
    ...over
  }) as unknown as CMSField

describe('shared text fields (co-edited rich text, open under a held record lock)', () => {
  it('only plain rich-text fields are shared', () => {
    expect(sharedTextFieldRow(field({}))).toBe(true)
    expect(sharedTextFieldRow(field({ interface: 'rich_text' }))).toBe(true)
    expect(sharedTextFieldRow(field({ interface: null, type: 'rich_text' }))).toBe(true)
    expect(sharedTextFieldRow(field({ interface: 'input' }))).toBe(false)
    expect(sharedTextFieldRow(field({ interface: 'textarea' }))).toBe(false)
    expect(sharedTextFieldRow(field({ is_encrypted: true }))).toBe(false)
    expect(sharedTextFieldRow(field({ computed_type: 'write' }))).toBe(false)
    expect(sharedTextFieldRow(field({ special: ['conceal'] }))).toBe(false)
    expect(sharedTextFieldRow(field({}), true)).toBe(false)
    expect(sharedTextFieldRow(null)).toBe(false)
  })

  it('a save passes the held lock only when it changes shared text and nothing else', async () => {
    const shared = async (_c: string, f: string) => f === 'notes' || f === 'scope'
    expect(await onlySharedText('workflows', { notes: '<p>x</p>' }, shared)).toBe(true)
    expect(await onlySharedText('workflows', { notes: 'a', scope: 'b' }, shared)).toBe(true)
    // Anything else in the same save: the lock applies as always.
    expect(await onlySharedText('workflows', { notes: 'a', amount: 5 }, shared)).toBe(false)
    expect(await onlySharedText('workflows', { status: 'x' }, shared)).toBe(false)
    expect(await onlySharedText('workflows', {}, shared)).toBe(false)
    expect(await onlySharedText('workflows', null, shared)).toBe(false)
    expect(await onlySharedText('workflows', [{ notes: 'a' }], shared)).toBe(false)
    expect(
      await onlySharedText('workflows', { notes: 'a' }, async () => {
        throw new Error('db down')
      })
    ).toBe(false)
  })
})
