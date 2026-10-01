import { describe, expect, it } from 'vitest'
import {
  CLIENT_HEADER,
  clientVersion,
  clientVersionHeader,
  noteApiVersion,
  noteApiVersionFrom,
  setClientBuild
} from './client-version'
import { PageContext } from './page-context'

describe('client version signal (#1048 / #1180)', () => {
  it('sends nothing until the host names its build, then one header with every field', () => {
    expect(clientVersionHeader()).toBeNull()
    expect(new PageContext('admin').headers('/x')[CLIENT_HEADER]).toBeUndefined()
    setClientBuild('0.2.12')
    const v = clientVersion()
    expect(v.build).toBe('0.2.12')
    expect(v.tab).toMatch(/^[a-z0-9]+$/)
    expect(clientVersion().tab).toBe(v.tab)
    expect(clientVersionHeader()).toBe(`build=0.2.12; tab=${v.tab}; loaded=${v.loaded}`)
    expect(new PageContext('admin').headers('/x')[CLIENT_HEADER]).toBe(clientVersionHeader())
  })

  it('keeps the first API version it heard (later answers never replace it)', () => {
    noteApiVersionFrom(new Response(null, { headers: { 'x-nivaro-version': '0.2.11' } }))
    noteApiVersion('0.2.12')
    expect(clientVersion().api).toBe('0.2.11')
    expect(clientVersionHeader()).toContain('api=0.2.11')
  })
})
