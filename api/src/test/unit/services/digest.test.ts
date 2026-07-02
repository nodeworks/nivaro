import { describe, expect, it } from 'vitest'
import { buildQueueSummaryHtml } from '../../../services/digest.js'

describe('buildQueueSummaryHtml', () => {
  const stats = { total: 12, by_state: { draft: 5, review: 7 }, unowned: 3 }

  it('includes the queue name', () => {
    expect(buildQueueSummaryHtml('My Queue', stats, 'https://example.test/queues/1')).toContain(
      'My Queue'
    )
  })

  it('includes the total count', () => {
    expect(buildQueueSummaryHtml('My Queue', stats, 'https://example.test/queues/1')).toContain(
      '12'
    )
  })

  it('includes the unowned count', () => {
    expect(buildQueueSummaryHtml('My Queue', stats, 'https://example.test/queues/1')).toContain('3')
  })

  it('links to the queue URL', () => {
    expect(buildQueueSummaryHtml('My Queue', stats, 'https://example.test/queues/1')).toContain(
      'https://example.test/queues/1'
    )
  })

  it('escapes an HTML-unsafe queue name', () => {
    const html = buildQueueSummaryHtml('<b>Bad</b>', stats, 'https://example.test/queues/1')
    expect(html).not.toContain('<b>Bad</b>')
    expect(html).toContain('&lt;b&gt;Bad&lt;/b&gt;')
  })
})
