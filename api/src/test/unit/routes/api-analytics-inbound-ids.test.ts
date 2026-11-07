import { describe, expect, it, vi } from 'vitest'

// army6 M54: Integrations › Inbound listed raw paths with uuids, and every
// View-as session-recording upload as a refused call.

vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => ({}) }) }))

const { isViewAsRecordingUpload } = await import('../../../routes/api-analytics.js')
const { pathTemplate } = await import('../../../services/traffic-entities.js')

describe('inbound rows carry routes, not ids', () => {
  it('folds a recording upload path to its template', () => {
    expect(
      pathTemplate('/api/session-recordings/433e7906-6be2-4f44-b150-d26b06874919/events')
    ).toBe('/api/session-recordings/:id/events')
    expect(pathTemplate('/api/items/workflows/372962')).toBe('/api/items/workflows/:id')
  })

  it('treats a View-as recording upload as expected, not a failure', () => {
    expect(
      isViewAsRecordingUpload({
        auth: 'masquerade',
        path: '/api/session-recordings/433e7906-6be2-4f44-b150-d26b06874919/events'
      })
    ).toBe(true)
    expect(
      isViewAsRecordingUpload({ auth: 'token', path: '/api/session-recordings/x/events' })
    ).toBe(false)
    expect(isViewAsRecordingUpload({ auth: 'masquerade', path: '/api/items/workflows/1' })).toBe(
      false
    )
  })
})
