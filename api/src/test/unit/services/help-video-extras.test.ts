import { describe, expect, it } from 'vitest'
import {
  buildPeaksArgs,
  buildSpriteArgs,
  PEAK_PCM_RATE,
  parsePeaks,
  parseSprite,
  peaksFromPcm,
  SPRITE_MAX_TILES,
  spriteGeometry
} from '../../../services/help-video-extras.js'

// #1560: the sprite sheet geometry and the peaks maths, with no ffmpeg.

describe('spriteGeometry', () => {
  it('takes one frame a second for a short recording, 160 px tiles at the frame shape', () => {
    const g = spriteGeometry(12_500, 1920, 1080)
    expect(g).toEqual({
      tile_w: 160,
      tile_h: 90,
      cols: 10,
      rows: 2,
      count: 13, // frames at 0, 1, … 12 s
      interval_ms: 1000
    })
  })
  it('spreads the frames so a 30-minute recording stays within the tile cap', () => {
    const g = spriteGeometry(30 * 60_000, 1280, 720)
    expect(g?.interval_ms).toBe(9000)
    expect(g?.count).toBeLessThanOrEqual(SPRITE_MAX_TILES)
    expect(g?.count).toBe(200)
    expect(g?.rows).toBe(20)
  })
  it('keeps tile heights even and never below 2', () => {
    expect(spriteGeometry(5000, 1000, 1001)?.tile_h).toBe(160)
    expect(spriteGeometry(5000, 2000, 17)?.tile_h).toBe(2)
  })
  it('fits the columns to a tiny recording', () => {
    expect(spriteGeometry(2500, 640, 360)).toMatchObject({ cols: 3, rows: 1, count: 3 })
  })
  it('builds nothing for an unknown length or size, or a frame too large', () => {
    expect(spriteGeometry(null, 1280, 720)).toBeNull()
    expect(spriteGeometry(0, 1280, 720)).toBeNull()
    expect(spriteGeometry(5000, null, 720)).toBeNull()
    expect(spriteGeometry(5000, 7680, 4320)).toBeNull()
    expect(spriteGeometry(5000, 4096, 2304)).not.toBeNull()
  })
})

describe('buildSpriteArgs / buildPeaksArgs', () => {
  const g = spriteGeometry(12_500, 1920, 1080)!
  it('pins the container, bounds the read, and tiles one JPEG', () => {
    const args = buildSpriteArgs(
      { path: '/w/src.webm', mime: 'video/webm', threads: 2 },
      g,
      '/w/s.jpg'
    )
    expect(args.slice(0, 2)).toEqual(['-y', '-v'])
    expect(args).toContain('-format_whitelist')
    expect(args[args.indexOf('-i') + 1]).toBe('/w/src.webm')
    expect(args[args.indexOf('-vf') + 1]).toBe('fps=1/1,scale=160:90:flags=area,tile=10x2')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
    expect(args[args.indexOf('-t') + 1]).toBe(String(31 * 60 + 1))
    expect(args).toContain('-an')
    expect(args[args.length - 1]).toBe('/w/s.jpg')
  })
  it('writes mono 16-bit PCM at the peak rate', () => {
    const args = buildPeaksArgs({ path: '/w/src.mp4', mime: 'video/mp4' }, '/w/p.pcm')
    expect(args[args.indexOf('-ar') + 1]).toBe(String(PEAK_PCM_RATE))
    expect(args[args.indexOf('-ac') + 1]).toBe('1')
    expect(args[args.indexOf('-f') + 1]).toBe('mov,mp4,m4a,3gp,3g2,mj2') // the input lock comes first
    expect(args.slice(-3)).toEqual(['-acodec', 'pcm_s16le', '/w/p.pcm'])
    expect(args).toContain('-vn')
  })
  it('refuses a container ffmpeg would have to guess', () => {
    expect(() => buildSpriteArgs({ path: 'x', mime: 'video/quicktime' }, g, 'o')).toThrow(
      /Unsupported/
    )
    expect(() => buildPeaksArgs({ path: 'x', mime: 'application/octet-stream' }, 'o')).toThrow(
      /Unsupported/
    )
  })
})

describe('peaksFromPcm', () => {
  const pcm = (samples: number[]) => {
    const b = Buffer.alloc(samples.length * 2)
    for (const [i, v] of samples.entries()) b.writeInt16LE(v, i * 2)
    return b
  }
  it('takes the loudest sample of every window, as a 0–1 value with two decimals', () => {
    // 4 samples per 100 ms window at 40 Hz.
    const out = peaksFromPcm(pcm([0, 100, -16384, 50, 0, 0, 0, 0, 32767]), 40, 100)
    expect(out).toEqual([0.5, 0, 1])
  })
  it('is empty for no sound', () => {
    expect(peaksFromPcm(Buffer.alloc(0))).toEqual([])
    expect(peaksFromPcm(Buffer.alloc(1))).toEqual([]) // half a sample
  })
  it('reads 100 ms windows at the default rate', () => {
    const silent = Buffer.alloc(PEAK_PCM_RATE * 2 * 2) // two seconds
    expect(peaksFromPcm(silent)).toHaveLength(20)
  })
})

describe('parseSprite / parsePeaks', () => {
  const FILE = '11111111-1111-4111-8111-111111111111'
  it('reads a stored descriptor and lower-cases the file id', () => {
    expect(
      parseSprite(
        JSON.stringify({
          file_id: FILE.toUpperCase(),
          tile_w: 160,
          tile_h: 90,
          cols: 10,
          count: 13,
          interval_ms: 1000
        })
      )
    ).toEqual({ file_id: FILE, tile_w: 160, tile_h: 90, cols: 10, count: 13, interval_ms: 1000 })
  })
  it('is null for anything incomplete or odd', () => {
    expect(parseSprite(null)).toBeNull()
    expect(parseSprite('{oops')).toBeNull()
    expect(parseSprite({ file_id: FILE, tile_w: 160 })).toBeNull()
    expect(
      parseSprite({ file_id: 'x', tile_w: 1, tile_h: 1, cols: 1, count: 1, interval_ms: 1 })
    ).toBeNull()
    expect(
      parseSprite({ file_id: FILE, tile_w: 0, tile_h: 1, cols: 1, count: 1, interval_ms: 1 })
    ).toBeNull()
  })
  it('reads peaks from JSON, clamps them, and has none for an empty list', () => {
    expect(parsePeaks('[0.5, 2, -1, "x"]')).toEqual([0.5, 1, 0, 0])
    expect(parsePeaks([0.25])).toEqual([0.25])
    expect(parsePeaks('[]')).toBeNull()
    expect(parsePeaks(null)).toBeNull()
    expect(parsePeaks('nope')).toBeNull()
  })
})
