import { describe, expect, it } from 'vitest'
import { buildZip } from '../../../services/zip-writer.js'

describe('buildZip', () => {
  it('writes a two-file archive', () => {
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dir/b.json', data: Buffer.from('{}') }
    ])
    expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04')
    const end = zip.subarray(zip.length - 22)
    expect(end.subarray(0, 4).toString('latin1')).toBe('PK\x05\x06')
    expect(end.readUInt16LE(10)).toBe(2)
    const central = zip.subarray(end.readUInt32LE(16), zip.length - 22)
    expect(central.toString('utf8')).toContain('a.txt')
    expect(central.toString('utf8')).toContain('dir/b.json')
  })
})
