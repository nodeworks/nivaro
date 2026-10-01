import { afterEach, describe, expect, it } from 'vitest'
import { observeRequest, renderMetrics, resetMetrics } from '../../../plugins/metrics.js'

afterEach(() => resetMetrics())

describe('metrics exposition (#1088)', () => {
  it('counts requests per route pattern and status class, with cumulative buckets', () => {
    observeRequest('GET', '/api/items/:collection', 200, 0.02)
    observeRequest('GET', '/api/items/:collection', 204, 0.3)
    observeRequest('GET', '/api/items/:collection', 500, 2)
    const text = renderMetrics()
    expect(text).toContain(
      'nivaro_http_requests_total{method="GET",route="/api/items/:collection",status="2xx"} 2'
    )
    expect(text).toContain(
      'nivaro_http_requests_total{method="GET",route="/api/items/:collection",status="5xx"} 1'
    )
    const l = 'method="GET",route="/api/items/:collection",status="2xx"'
    expect(text).toContain(`nivaro_http_request_duration_seconds_bucket{${l},le="0.025"} 1`)
    expect(text).toContain(`nivaro_http_request_duration_seconds_bucket{${l},le="0.5"} 2`)
    expect(text).toContain(`nivaro_http_request_duration_seconds_bucket{${l},le="+Inf"} 2`)
    expect(text).toContain(`nivaro_http_request_duration_seconds_count{${l}} 2`)
  })

  it('reports the process, the version and the scheduler lease', () => {
    const text = renderMetrics({ cronLeader: true })
    expect(text).toMatch(/^nivaro_info\{version="[^"]+",instance="[^"]+",role="[^"]*"\} 1$/m)
    expect(text).toMatch(/^process_resident_memory_bytes \d+$/m)
    expect(text).toContain('nivaro_cron_leader 1')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('escapes label values', () => {
    observeRequest('GET', '/a"b\\c', 200, 0.001)
    expect(renderMetrics()).toContain('route="/a\\"b\\\\c"')
  })
})
