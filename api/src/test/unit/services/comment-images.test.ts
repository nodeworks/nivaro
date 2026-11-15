import { describe, expect, it } from 'vitest'
import { commentTextForPreview } from '../../../services/comment-images.js'
import { extractFileIds } from '../../../services/config-review/pure.js'

const ID = '0a1b2c3d-1111-4222-8333-444455556666'

describe('comment images', () => {
  it('reads each pasted image line as a short word in plain-text places', () => {
    expect(commentTextForPreview(`look\n![screenshot-1.png](/api/files/${ID})`)).toBe(
      'look\n[image: screenshot-1.png]'
    )
    expect(commentTextForPreview(`![](/api/files/${ID})`)).toBe('[image]')
    expect(commentTextForPreview('no image /api/files/nope')).toBe('no image /api/files/nope')
  })

  it('leaves the file id in the stored text, so file-attribution still ties it to the record', () => {
    const stored = `see this\n![shot.png](/api/files/${ID})`
    expect([...extractFileIds(stored)]).toEqual([ID.toUpperCase()])
  })
})
