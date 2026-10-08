import { describe, expect, it } from 'vitest'
import {
  decidePart,
  MAX_PART_BYTES,
  MAX_UPLOAD_BYTES
} from '../../../services/help-video-uploads.js'

const s = { next_part: 3, last_part_bytes: 1000, bytes_received: 5000 }

describe('decidePart', () => {
  it('appends the next part', () => expect(decidePart(s, 3, 800)).toBe('append'))
  it('accepts a resent last part of the same size as a duplicate', () =>
    expect(decidePart(s, 2, 1000)).toBe('duplicate'))
  it('refuses a resent part of another size', () =>
    expect(decidePart(s, 2, 999)).toMatchObject({ status: 409 }))
  it('refuses a gap', () => expect(decidePart(s, 5, 10)).toMatchObject({ status: 409 }))
  it('refuses an empty part', () => expect(decidePart(s, 3, 0)).toMatchObject({ status: 400 }))
  it('refuses a part over 8 MB', () =>
    expect(decidePart(s, 3, MAX_PART_BYTES + 1)).toMatchObject({ status: 413 }))
  it('refuses going past 1.2 GB', () =>
    expect(decidePart({ ...s, bytes_received: MAX_UPLOAD_BYTES - 10 }, 3, 11)).toMatchObject({
      status: 413
    }))
})
