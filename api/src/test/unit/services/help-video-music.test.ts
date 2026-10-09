import { describe, expect, it } from 'vitest'
import {
  annotationFade,
  hashEdits,
  normalizeEdits,
  normalizeMusic
} from '../../../services/help-video-edits.js'
import { sniffAudio, synthesizeTrack } from '../../../services/help-video-music.js'
import {
  buildRenderArgs,
  musicShareWindows,
  musicVolumeExpr
} from '../../../services/help-video-render-plan.js'
import { viewerMayPlaySource } from '../../../services/help-video-views.js'

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const base = {
  width: 1280,
  height: 720,
  hasAudio: true,
  sourcePath: 'in.webm',
  sourceMime: 'video/webm',
  overlays: [],
  outputPath: 'out.mp4',
  threads: 2
}
const fc = (args: string[]) => args[args.indexOf('-filter_complex') + 1]
const lib = {
  enabled: true,
  source: 'library',
  track: 'calm',
  name: 'Calm',
  volume: 0.3,
  duck: true
}

describe('normalizeMusic', () => {
  it('keeps a library track and an uploaded file', () => {
    expect(normalizeMusic(lib)).toEqual(lib)
    expect(normalizeMusic({ ...lib, source: 'upload', track: ID.toUpperCase() })?.track).toBe(ID)
  })
  it('refuses a mismatched source and track, and anything off', () => {
    expect(normalizeMusic({ ...lib, source: 'upload' })).toBeNull()
    expect(normalizeMusic({ ...lib, track: ID })).toBeNull()
    expect(normalizeMusic({ ...lib, enabled: false })).toBeNull()
    expect(normalizeMusic({ ...lib, track: '../etc/passwd' })).toBeNull()
  })
  it('clamps the volume and defaults ducking on', () => {
    const m = normalizeMusic({ enabled: true, source: 'library', track: 'calm', volume: 9 })
    expect(m?.volume).toBe(1)
    expect(m?.duck).toBe(true)
    expect(normalizeMusic({ ...lib, volume: 0 })?.volume).toBe(0.05)
  })
})

describe('music in the edits', () => {
  const plain = { segments: [{ start_ms: 0, end_ms: 4000, speed: 1 }] }
  it('leaves edits without music (and their hash) exactly as they were', () => {
    const e = normalizeEdits(plain, 4000)
    expect('music' in e).toBe(false)
    expect('music' in e.segments[0]).toBe(false)
    expect(hashEdits(e)).toBe(hashEdits(normalizeEdits(plain, 4000)))
  })
  it("stores a piece's share only with music on, and only when not 1", () => {
    const segs = [
      { start_ms: 0, end_ms: 2000, speed: 1, music: 0 },
      { start_ms: 2000, end_ms: 4000, speed: 1, music: 1 }
    ]
    const on = normalizeEdits({ segments: segs, music: lib }, 4000)
    expect(on.segments[0].music).toBe(0)
    expect('music' in on.segments[1]).toBe(false)
    const off = normalizeEdits({ segments: segs }, 4000)
    expect('music' in off.segments[0]).toBe(false)
  })
  it('keeps viewers off the original when there is music', () => {
    expect(viewerMayPlaySource({ segments: [{ start_ms: 0, end_ms: 4000, speed: 1 }] }, 4000)).toBe(
      true
    )
    expect(viewerMayPlaySource({ ...plain, music: lib }, 4000)).toBe(false)
  })
})

describe('annotationFade', () => {
  it('is 200 ms, or half a short item', () => {
    expect(annotationFade(0, 3000)).toBe(200)
    expect(annotationFade(0, 300)).toBe(150)
  })
})

describe('the generated tracks', () => {
  it('are WAV loops that join without a click', () => {
    for (const key of ['calm', 'bright', 'focus']) {
      const wav = synthesizeTrack(key)
      expect(wav).not.toBeNull()
      const b = wav as Buffer
      expect(b.subarray(0, 4).toString()).toBe('RIFF')
      const n = (b.length - 44) / 2
      const first = b.readInt16LE(44)
      const last = b.readInt16LE(44 + (n - 1) * 2)
      // One sample apart at 32 kHz: the step across the loop seam is as small
      // as any ordinary step in the track.
      expect(Math.abs(first - last)).toBeLessThan(1500)
    }
    expect(synthesizeTrack('nope')).toBeNull()
  })
})

describe('sniffAudio', () => {
  const pad = (s: string, at = 0) => {
    const b = Buffer.alloc(16)
    b.write(s, at, 'latin1')
    return b
  }
  it('names the containers it knows', () => {
    expect(sniffAudio(Buffer.concat([pad('RIFF'), Buffer.alloc(0)]).fill('WAVE', 8, 12))).toBe(
      'audio/wav'
    )
    expect(sniffAudio(pad('ID3'))).toBe('audio/mpeg')
    expect(sniffAudio(pad('OggS'))).toBe('audio/ogg')
    expect(sniffAudio(pad('fLaC'))).toBe('audio/flac')
    expect(sniffAudio(pad('ftyp', 4))).toBe('audio/mp4')
    expect(sniffAudio(pad('#EXTM3U'))).toBeNull()
  })
})

describe('music in the render', () => {
  const edits = normalizeEdits(
    {
      segments: [
        { start_ms: 0, end_ms: 2000, speed: 1 },
        { start_ms: 3000, end_ms: 5000, speed: 2, music: 0 }
      ],
      music: lib
    },
    5000
  )
  it("maps each piece's share onto the edited timeline", () => {
    expect(musicShareWindows(edits)).toEqual([{ start_ms: 2000, end_ms: 3000, share: 0 }])
    expect(musicVolumeExpr(edits)).toBe('1+(-1.00)*between(t,2.000,2.999)')
  })
  it('loops the music last, lowers it under the narration and mixes it in', () => {
    const args = buildRenderArgs({ ...base, edits, music: { path: 'm.wav', mime: 'audio/wav' } })
    const i = args.indexOf('m.wav')
    expect(args.slice(i - 9, i - 1)).toEqual([
      '-stream_loop',
      '-1',
      '-protocol_whitelist',
      'file',
      '-f',
      'wav',
      '-format_whitelist',
      'wav'
    ])
    const g = fc(args)
    expect(g).toContain('[1:a]')
    expect(g).toContain('volume=0.30')
    expect(g).toContain('sidechaincompress')
    expect(g).toContain(
      '[anar]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=2[anarm][asc]'
    )
    expect(g).toMatch(/amix=inputs=2[^;]*\[aout\]$/)
    expect(args).toContain('[aout]')
  })
  it('gives a silent recording a track for the music, with nothing to duck under', () => {
    const args = buildRenderArgs({
      ...base,
      hasAudio: false,
      edits,
      music: { path: 'm.wav', mime: 'audio/wav' }
    })
    const g = fc(args)
    expect(g).toContain('anullsrc')
    expect(g).not.toContain('sidechaincompress')
    expect(args).toContain('[aout]')
    expect(args).toContain('aac')
  })
  it('refuses a music file without a pinned demuxer', () => {
    expect(() =>
      buildRenderArgs({ ...base, edits, music: { path: 'x', mime: 'application/x-mpegurl' } })
    ).toThrow(/Unsupported music format/)
  })
  it('leaves the graph as before without music', () => {
    const plain = normalizeEdits({ segments: [{ start_ms: 0, end_ms: 5000, speed: 1 }] }, 5000)
    const g = fc(buildRenderArgs({ ...base, edits: plain }))
    expect(g).toContain('[0:a]atrim=end=5.000,asetpts=PTS-STARTPTS[aout]')
    expect(g).not.toContain('sidechain')
  })
})

describe('overlay fades', () => {
  it('ramps a faded overlay in and out over its span', () => {
    const plain = normalizeEdits({ segments: [{ start_ms: 0, end_ms: 5000, speed: 1 }] }, 5000)
    const g = fc(
      buildRenderArgs({
        ...base,
        edits: plain,
        overlays: [
          { path: 'a.png', start_ms: 1000, end_ms: 3000, fade_ms: 200 },
          { path: 'b.png', start_ms: 1000, end_ms: 1300 }
        ]
      })
    )
    expect(g).toContain(
      '[1:v]format=rgba,loop=loop=60:size=1:start=0,setpts=N/(30*TB)+1.000/TB,fade=t=in:st=1.000:d=0.200:alpha=1,fade=t=out:st=2.800:d=0.200:alpha=1[ov0]'
    )
    expect(g).toContain("[ov0]overlay=0:0:eof_action=pass:enable='between(t,1.000,3.000)'")
    expect(g).toContain("[2:v]overlay=0:0:enable='between(t,1.000,1.300)'")
  })
})
