// Stored (uncompressed) zip writer, shared by the xlsx writer and app packages.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function buildZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name)
    const crc = crc32(f.data)
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4) // version needed
    h.writeUInt16LE(0x0800, 6) // UTF-8 names
    h.writeUInt16LE(0, 8) // stored
    h.writeUInt16LE(0, 10) // time
    h.writeUInt16LE(0x21, 12) // date 1980-01-01
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(f.data.length, 18)
    h.writeUInt32LE(f.data.length, 22)
    h.writeUInt16LE(name.length, 26)
    local.push(h, name, f.data)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x0800, 8)
    c.writeUInt16LE(0, 10)
    c.writeUInt16LE(0, 12)
    c.writeUInt16LE(0x21, 14)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(f.data.length, 20)
    c.writeUInt32LE(f.data.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, name)
    offset += 30 + name.length + f.data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuf, end])
}
