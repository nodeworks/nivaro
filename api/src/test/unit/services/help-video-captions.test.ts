import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ row: {} as Record<string, unknown> }))
vi.mock('../../../services/ai-client.js', () => ({
  settingsRow: vi.fn(async () => settings.row),
  gatewayFromSettings: (s: Record<string, string | null | undefined>) => ({
    base_url: (s.ai_gateway_base_url ?? '').replace(/\/+$/, ''),
    token_url: s.ai_gateway_token_url ?? '',
    client_id: s.ai_gateway_client_id ?? '',
    client_secret: s.ai_gateway_client_secret ?? ''
  }),
  parseAiModels: (s: { ai_models?: string | null }) => {
    try {
      return s.ai_models ? JSON.parse(s.ai_models) : {}
    } catch {
      return {}
    }
  },
  gatewayBearer: vi.fn(async () => 'tok'),
  bustGatewayBearer: vi.fn()
}))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async () => ({
    id: 7,
    progress: vi.fn(),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined)
  }))
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))

import {
  type CaptionDeps,
  CaptionsError,
  captionProvider,
  clearCaptionJob,
  extractAudioArgs,
  fillCommand,
  findOnPath,
  groupWords,
  markStale,
  parseVerboseJson,
  parseWhisperJson,
  processCaptionJob,
  readCaptionJob,
  resetLocalWhisperCheck,
  splitCommand,
  spreadSegment,
  startCaptionJob,
  type TranscriptWord,
  whenCaptionsIdle
} from '../../../services/help-video-captions.js'
import { startJobRun } from '../../../services/job-runs.js'

const w = (start: number, end: number, text: string): TranscriptWord => ({
  start_ms: start,
  end_ms: end,
  text
})

describe('groupWords', () => {
  it('breaks lines at 42 characters', () => {
    const words = 'one two three four five six seven eight nine ten eleven twelve'
      .split(' ')
      .map((t, i) => w(i * 300, i * 300 + 250, t))
    const lines = groupWords(words)
    expect(lines.every((l) => l.text.length <= 42)).toBe(true)
    expect(lines.map((l) => l.text)).toEqual([
      'one two three four five six seven eight',
      'nine ten eleven twelve'
    ])
    expect(lines[0]).toMatchObject({ start_ms: 0, end_ms: 2350 })
    expect(lines[1]).toMatchObject({ start_ms: 2400 })
  })
  it('breaks a line after 5 seconds, after a pause, and after a sentence', () => {
    const slow = groupWords([w(0, 1000, 'a'), w(1500, 2500, 'b'), w(3500, 5500, 'c')])
    expect(slow.map((l) => l.text)).toEqual(['a b', 'c'])
    const pause = groupWords([w(0, 500, 'a'), w(2000, 2500, 'b')])
    expect(pause.map((l) => l.text)).toEqual(['a', 'b'])
    const sentence = groupWords([
      w(0, 500, 'This'),
      w(500, 1000, 'is'),
      w(1000, 1500, 'the'),
      w(1500, 2000, 'first'),
      w(2000, 2500, 'sentence.'),
      w(2500, 3000, 'Next')
    ])
    expect(sentence.map((l) => l.text)).toEqual(['This is the first sentence.', 'Next'])
  })
  it('never overlaps lines, keeps the minimum length and stops at the source end', () => {
    const lines = groupWords([w(0, 5000, 'long'), w(100, 150, 'x')], 4000)
    expect(lines).toEqual([expect.objectContaining({ start_ms: 0, end_ms: 4000, text: 'long x' })])
    const tiny = groupWords([w(0, 10, 'a'), w(2000, 2010, 'b')])
    expect(tiny).toEqual([
      expect.objectContaining({ start_ms: 0, end_ms: 200 }),
      expect.objectContaining({ start_ms: 2000, end_ms: 2200 })
    ])
    expect(groupWords([w(0, 10, 'a'), w(0, 10, 'b')], 100)).toEqual([])
    expect(groupWords([w(0, 1000, '   '), w(Number.NaN, 1, 'x')])).toEqual([])
  })
  it('gives every line an id and sorts the words first', () => {
    const lines = groupWords([w(2000, 2500, 'later'), w(0, 500, 'first')])
    expect(lines[0].text).toBe('first')
    expect(lines.every((l) => /^[0-9a-f]{12}$/.test(l.id))).toBe(true)
  })
})

describe('spreadSegment', () => {
  it('spreads the words over the span by their length', () => {
    expect(spreadSegment(1000, 2000, 'ab cd')).toEqual([
      { start_ms: 1000, end_ms: 1500, text: 'ab' },
      { start_ms: 1500, end_ms: 2000, text: 'cd' }
    ])
    expect(spreadSegment(0, 10, '  ')).toEqual([])
  })
})

describe('parseVerboseJson', () => {
  it('reads word timings in seconds, the duration and the usage', () => {
    const r = parseVerboseJson({
      text: 'hello world',
      duration: 1.5,
      words: [
        { word: 'hello', start: 0, end: 0.5 },
        { word: 'world', start: 0.6, end: 1.5 },
        { word: '', start: 2, end: 3 }
      ],
      usage: { type: 'tokens', input_tokens: 12, output_tokens: 3 }
    })
    expect(r.words).toEqual([w(0, 500, 'hello'), w(600, 1500, 'world')])
    expect(r.duration_ms).toBe(1500)
    expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 3, seconds: 1.5 })
  })
  it('falls back to segments, then to the whole text', () => {
    expect(
      parseVerboseJson({ segments: [{ start: 1, end: 2, text: 'a b' }], usage: { seconds: 2 } })
    ).toMatchObject({ words: [w(1000, 1500, 'a'), w(1500, 2000, 'b')], usage: { seconds: 2 } })
    expect(parseVerboseJson({ text: 'x y', duration: 2 }).words).toEqual([
      w(0, 1000, 'x'),
      w(1000, 2000, 'y')
    ])
    expect(parseVerboseJson(null).words).toEqual([])
  })
})

describe('parseWhisperJson', () => {
  it('joins byte-pair tokens into words and skips specials', () => {
    const r = parseWhisperJson({
      transcription: [
        {
          offsets: { from: 0, to: 2000 },
          text: ' Hello there',
          tokens: [
            { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
            { text: ' Hel', offsets: { from: 100, to: 300 } },
            { text: 'lo', offsets: { from: 300, to: 500 } },
            { text: ' there', offsets: { from: 600, to: 1000 } },
            { text: '[_TT_500]', offsets: { from: 1000, to: 1000 } }
          ]
        },
        { offsets: { from: 2000, to: 3000 }, text: ' no tokens here' }
      ]
    })
    expect(r.words).toEqual([
      w(100, 500, 'Hello'),
      w(600, 1000, 'there'),
      w(2000, 2167, 'no'),
      w(2167, 2667, 'tokens'),
      w(2667, 3000, 'here')
    ])
    expect(r.duration_ms).toBe(3000)
    expect(parseWhisperJson({}).words).toEqual([])
  })
})

describe('ffmpeg and the local command', () => {
  it('extracts mono 16 kHz PCM with the container pinned and the length bounded', () => {
    const args = extractAudioArgs('/tmp/s.webm', 'video/webm', '/tmp/a.wav', 1_860_000)
    expect(args).toEqual([
      '-nostdin',
      '-y',
      '-protocol_whitelist',
      'file',
      '-f',
      'matroska,webm',
      '-format_whitelist',
      'matroska,webm',
      '-i',
      '/tmp/s.webm',
      '-t',
      '1860.000',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      '/tmp/a.wav'
    ])
  })
  it('splits a template without a shell and fills the placeholders per argument', () => {
    const args = splitCommand(`whisper-cli -m "{model}" -f {input} -ojf -of '{output}' -t 2`)
    expect(args).toEqual([
      'whisper-cli',
      '-m',
      '{model}',
      '-f',
      '{input}',
      '-ojf',
      '-of',
      '{output}',
      '-t',
      '2'
    ])
    expect(
      fillCommand(args, { input: '/a b/in.wav', output: '/a b/out', model: '/m/base.bin' })
    ).toEqual([
      'whisper-cli',
      '-m',
      '/m/base.bin',
      '-f',
      '/a b/in.wav',
      '-ojf',
      '-of',
      '/a b/out',
      '-t',
      '2'
    ])
    expect(splitCommand('')).toEqual([])
  })
  it('finds a binary on PATH or by its path', async () => {
    expect(await findOnPath('sh', '/usr/bin:/bin')).toMatch(/\/sh$/)
    expect(await findOnPath('definitely-not-a-binary-xyz', '/usr/bin:/bin')).toBeNull()
    expect(await findOnPath('/definitely/not/here')).toBeNull()
    expect(await findOnPath('')).toBeNull()
  })
})

describe('captionProvider', () => {
  beforeEach(() => {
    resetLocalWhisperCheck()
    settings.row = {}
    delete process.env.HELP_VIDEO_WHISPER_CMD
    delete process.env.HELP_VIDEO_WHISPER_MODEL
  })
  afterEach(() => {
    delete process.env.HELP_VIDEO_WHISPER_CMD
    delete process.env.HELP_VIDEO_WHISPER_MODEL
  })
  it('prefers the gateway model when the gateway is configured for it', async () => {
    settings.row = {
      ai_provider: 'gateway',
      ai_gateway_base_url: 'https://gw/',
      ai_gateway_token_url: 'https://gw/token',
      ai_gateway_client_id: 'id',
      ai_gateway_client_secret: 'secret',
      ai_models: JSON.stringify({ transcribe: 'whisper-1' })
    }
    expect(await captionProvider()).toEqual({ kind: 'gateway', model: 'whisper-1' })
  })
  it('falls back to a local command that exists, with its model file', async () => {
    process.env.HELP_VIDEO_WHISPER_CMD = 'sh -c {input} {output}'
    expect(await captionProvider()).toEqual({
      kind: 'local',
      command: ['sh', '-c', '{input}', '{output}'],
      model: null
    })
    resetLocalWhisperCheck()
    process.env.HELP_VIDEO_WHISPER_CMD = 'sh -m {model} -f {input}'
    process.env.HELP_VIDEO_WHISPER_MODEL = '/no/such/model.bin'
    const none = await captionProvider()
    expect(none.kind).toBe('none')
    expect(none.kind === 'none' && none.reason).toMatch(
      /Whisper model file \(HELP_VIDEO_WHISPER_MODEL\) is missing/
    )
  })
  it('explains what an administrator must set up when there is nothing', async () => {
    process.env.HELP_VIDEO_WHISPER_CMD = 'no-such-whisper-binary -f {input}'
    const r = await captionProvider()
    expect(r.kind).toBe('none')
    expect(r.kind === 'none' && r.reason).toMatch(/Settings → AI Features/)
    expect(r.kind === 'none' && r.reason).toMatch(/HELP_VIDEO_WHISPER_CMD/)
    // The command name and model path stay out of what the client sees.
    expect(r.kind === 'none' && r.reason).toMatch(/configured command is not installed/)
    expect(r.kind === 'none' && r.reason).not.toMatch(/no-such-whisper-binary/)
    settings.row = { ai_provider: 'gateway' }
    resetLocalWhisperCheck()
    expect((await captionProvider()) as { reason?: string }).toMatchObject({
      reason: expect.stringMatching(/gateway has no Captions model/)
    })
  })
})

describe('the job', () => {
  const VID = '11111111-2222-4333-8444-555555555555'
  const VER = 'aaaaaaaa-2222-4333-8444-555555555555'
  const logs: Array<Record<string, unknown>> = []
  function deps(over: Partial<CaptionDeps> = {}): CaptionDeps {
    return {
      provider: async () => ({ kind: 'gateway', model: 'whisper-1' }),
      loadSource: async (_v, dir) => ({
        path: `${dir}/source.webm`,
        mime: 'video/webm',
        source_ms: 9000
      }),
      extractAudio: async () => undefined,
      transcribeGateway: async () => ({
        words: [w(0, 500, 'hello'), w(600, 1000, 'world')],
        duration_ms: 1000,
        usage: { input_tokens: 5, output_tokens: 2, seconds: 1 }
      }),
      transcribeLocal: async () => ({ words: [w(0, 500, 'local')], duration_ms: 500 }),
      heavy: async (_l, work) => work(),
      log: (row) => {
        logs.push(row as unknown as Record<string, unknown>)
      },
      ...over
    }
  }
  beforeEach(async () => {
    logs.length = 0
    vi.mocked(startJobRun).mockClear()
    await clearCaptionJob(VER)
  })

  it('queues, runs through the gateway, keeps the lines as a pending set and logs the call', async () => {
    const d = deps()
    const job = await startCaptionJob({ id: VID }, VER, { id: 'U1' }, d)
    expect(job).toMatchObject({
      status: 'queued',
      provider: 'gateway',
      model: 'whisper-1',
      requested_by: 'U1'
    })
    await whenCaptionsIdle()
    const done = await readCaptionJob(VER)
    expect(done).toMatchObject({
      status: 'done',
      provider: 'gateway',
      words: 2,
      audio_ms: 1000,
      run_id: 7,
      captions: [expect.objectContaining({ start_ms: 0, end_ms: 1000, text: 'hello world' })]
    })
    expect(done?.phase).toBeUndefined()
    expect(logs).toEqual([
      expect.objectContaining({
        feature: 'help-video-captions',
        provider: 'gateway-openai',
        model: 'whisper-1',
        status: 'ok',
        user: 'U1',
        input_tokens: 5,
        output_tokens: 2,
        route: `/help-videos/${VID}/captions/generate`,
        response: { words: 2, lines: 1, audio_ms: 1000, seconds: 1 }
      })
    ])
    expect(startJobRun).toHaveBeenCalledWith(
      'ai',
      `help-video-captions:${VER}`,
      expect.objectContaining({ triggeredBy: 'U1' })
    )
  })
  it('runs the local command inside the heavy slot and logs it as local-whisper with its duration', async () => {
    const slots: string[] = []
    const d = deps({
      provider: async () => ({
        kind: 'local',
        command: ['whisper-cli', '-m', '{model}'],
        model: '/opt/whisper/ggml-base.en.bin'
      }),
      heavy: async (label, work) => {
        slots.push(label)
        await work()
      }
    })
    await startCaptionJob({ id: VID }, VER, null, d)
    await whenCaptionsIdle()
    expect(slots).toEqual(['help-video captions'])
    expect(await readCaptionJob(VER)).toMatchObject({ status: 'done', provider: 'local', words: 1 })
    expect(logs[0]).toMatchObject({
      provider: 'local-whisper',
      model: 'ggml-base.en.bin',
      status: 'ok',
      input_tokens: null
    })
    expect(typeof logs[0].latency_ms).toBe('number')
  })
  it('fails with a plain reason when the transcription throws, and logs the error', async () => {
    const d = deps({
      transcribeGateway: async () => Promise.reject(new Error('AI gateway 500: boom'))
    })
    await startCaptionJob({ id: VID }, VER, { id: 'U1' }, d)
    await whenCaptionsIdle()
    expect(await readCaptionJob(VER)).toMatchObject({
      status: 'failed',
      error: 'The AI gateway refused the request (AI gateway 500)'
    })
    // Process output and paths never reach the job the author reads.
    expect((await readCaptionJob(VER))?.error).not.toMatch(/boom/)
    expect(logs[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/boom/) })
    const missing = deps({
      loadSource: async () => Promise.reject(new Error('Stored object not found'))
    })
    await clearCaptionJob(VER)
    await startCaptionJob({ id: VID }, VER, null, missing)
    await whenCaptionsIdle()
    expect((await readCaptionJob(VER))?.error).toBe(
      'The original recording is missing from storage'
    )
  })
  it('refuses to start without a transcriber or while one is queued', async () => {
    await expect(
      startCaptionJob(
        { id: VID },
        VER,
        null,
        deps({ provider: async () => ({ kind: 'none', reason: 'nothing' }) })
      )
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'HELP_VIDEO_CAPTIONS_NOT_CONFIGURED',
      message: 'nothing'
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow = deps({
      transcribeGateway: async () => gate.then(() => ({ words: [], duration_ms: 0, usage: {} }))
    })
    await startCaptionJob({ id: VID }, VER, null, slow)
    await expect(startCaptionJob({ id: VID }, VER, null, slow)).rejects.toBeInstanceOf(
      CaptionsError
    )
    release()
    await whenCaptionsIdle()
    expect((await readCaptionJob(VER))?.status).toBe('done')
  })
  it('does nothing for a job that is not queued any more', async () => {
    expect(await processCaptionJob(VER, deps())).toBeNull()
  })
  it('reads a job the server died under as failed', () => {
    const old = new Date(Date.now() - 4 * 3_600_000).toISOString()
    expect(
      markStale({
        version_id: VER,
        video_id: VID,
        status: 'running',
        requested_by: null,
        requested_at: old
      })
    ).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/restarted/)
    })
    expect(
      markStale({
        version_id: VER,
        video_id: VID,
        status: 'done',
        requested_by: null,
        requested_at: old
      }).status
    ).toBe('done')
    const fresh = new Date().toISOString()
    expect(
      markStale({
        version_id: VER,
        video_id: VID,
        status: 'queued',
        requested_by: null,
        requested_at: fresh
      }).status
    ).toBe('queued')
  })
})
