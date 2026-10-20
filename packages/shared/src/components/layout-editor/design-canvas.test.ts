import { describe, expect, it, vi } from 'vitest'
import { del, get, patch, post, put } from '../../lib/commands'
import { designReadOnlyClient, isDesignAllowedRequest } from './design-canvas'

// The canvas's guarantee: nothing on a design-mode form can write. Reads and
// the few POSTs that only read pass; everything else is refused before it
// leaves the browser, and the refusal is reported.

describe('isDesignAllowedRequest', () => {
  it('lets reads and read-only POSTs through', () => {
    expect(isDesignAllowedRequest(get('/items/orders/1'))).toBe(true)
    expect(isDesignAllowedRequest(post('/field-config/orders/project', {}))).toBe(true)
    expect(isDesignAllowedRequest(post('/widgets-internal/7/render', {}))).toBe(true)
    expect(isDesignAllowedRequest(post('/items/batch-read', {}))).toBe(true)
    expect(isDesignAllowedRequest(post('/users/cards', {}))).toBe(true)
  })

  it('refuses every write, including POSTs that look like reads but store', () => {
    expect(isDesignAllowedRequest(post('/items/orders', {}))).toBe(false)
    expect(isDesignAllowedRequest(patch('/items/orders/1', {}))).toBe(false)
    expect(isDesignAllowedRequest(put('/drafts/orders/1', {}))).toBe(false)
    expect(isDesignAllowedRequest(del('/items/orders/1'))).toBe(false)
    expect(isDesignAllowedRequest(post('/record-views/orders/1/touch', {}))).toBe(false)
    expect(isDesignAllowedRequest(post('/config-conformance/record/orders/1/check', {}))).toBe(
      false
    )
    expect(isDesignAllowedRequest(post('/field-rules/evaluate', {}))).toBe(false)
    expect(isDesignAllowedRequest(post('/item-locks/orders/1', {}))).toBe(false)
    // A look-alike path is not the read.
    expect(isDesignAllowedRequest(post('/field-config/orders/project/extra', {}))).toBe(false)
  })
})

describe('designReadOnlyClient', () => {
  function base() {
    return {
      url: 'http://test',
      request: vi.fn(async () => ({ data: 'ok' })),
      graphql: vi.fn(async () => ({})),
      upload: vi.fn(async () => ({})),
      importParse: vi.fn(async () => ({})),
      getToken: vi.fn(() => 't')
    }
  }

  it('passes reads, refuses writes before the base client sees them, and reports each', async () => {
    const b = base()
    const onRefused = vi.fn()
    const c = designReadOnlyClient(b as never, onRefused)
    await expect(c.request(get('/items/orders/1'))).resolves.toEqual({ data: 'ok' })
    await expect(c.request(patch('/items/orders/1', { a: 1 }))).rejects.toThrow(/not saved/)
    expect(b.request).toHaveBeenCalledTimes(1)
    expect(onRefused).toHaveBeenCalledWith({ method: 'PATCH', path: '/items/orders/1' })
  })

  it('refuses GraphQL, uploads and import parsing whole', async () => {
    const b = base()
    const onRefused = vi.fn()
    const c = designReadOnlyClient(b as never, onRefused)
    await expect(c.graphql('mutation { x }')).rejects.toThrow()
    await expect(c.upload(new Blob() as File)).rejects.toThrow()
    await expect(c.importParse('t1', new Blob())).rejects.toThrow()
    expect(b.graphql).not.toHaveBeenCalled()
    expect(b.upload).not.toHaveBeenCalled()
    expect(b.importParse).not.toHaveBeenCalled()
    expect(onRefused.mock.calls.map(([w]) => w.method)).toEqual([
      'graphql',
      'upload',
      'importParse'
    ])
  })

  it('keeps everything else of the base client', () => {
    const b = base()
    const c = designReadOnlyClient(b as never)
    expect(c.url).toBe('http://test')
    expect(c.getToken()).toBe('t')
  })
})
