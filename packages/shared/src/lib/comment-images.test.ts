import { describe, expect, it } from 'vitest'
import {
  commentImageToken,
  splitCommentImages,
  stripCommentImages,
  withCommentImages
} from './comment-images'
import { uploadFailureMessage } from './upload-file'

const ID = '0a1b2c3d-1111-4222-8333-444455556666'

describe('comment images', () => {
  it('writes one line per image after the typed text', () => {
    expect(withCommentImages(' hi ', [{ id: ID, name: 'a.png' }])).toBe(
      `hi\n![a.png](/api/files/${ID})`
    )
    expect(withCommentImages('', [{ id: ID, name: 'a.png' }])).toBe(`![a.png](/api/files/${ID})`)
    expect(withCommentImages('  ', [])).toBe('')
  })

  it('keeps awkward names from breaking the token', () => {
    expect(commentImageToken(ID, 'a [b] (c)\n.png')).toBe(`![a b c .png](/api/files/${ID})`)
  })

  it('splits a posted comment into text and images, in order', () => {
    const parts = splitCommentImages(`before\n![x.png](/api/files/${ID})\nafter`)
    expect(parts.map((p) => p.kind)).toEqual(['text', 'image', 'text'])
    expect(parts[1]).toEqual({ kind: 'image', id: ID, name: 'x.png' })
  })

  it('previews an image as [image]', () => {
    expect(stripCommentImages(`a ![x](/api/files/${ID})`)).toBe('a [image]')
  })

  it('says a too-large upload in plain words', () => {
    expect(uploadFailureMessage(413, '')).toMatch(/too large/)
    expect(uploadFailureMessage(500, '{"error":"FST_ERR"}')).toBe('Upload failed')
    expect(uploadFailureMessage(400, '{"error":"File type not allowed"}')).toBe(
      'File type not allowed'
    )
  })
})
