import { describe, expect, it } from 'vitest'

// Streaming (#688): the openai chat/completions chunk translation and the
// event → message assembler are pure. These pin that a text stream, a tool
// call split over several chunks and the usage-only tail chunk translate
// into the Anthropic event shape, and that the assembled message equals
// what the non-streamed translation produces for the same answer.

import {
  abortError,
  assembleMessage,
  createMessageAssembler,
  eventsOfMessage,
  makeMessageStream,
  openAiChunkToEvents,
  openAiStreamEnd,
  openAiStreamState,
  takeSseData
} from '../../../services/ai-stream.js'

type Ev = Record<string, unknown>
const types = (events: unknown[]) => events.map((e) => (e as Ev).type)

describe('openAiChunkToEvents', () => {
  it('turns content deltas into one text block with text deltas', () => {
    const state = openAiStreamState('gw-model')
    const first = openAiChunkToEvents(
      { id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
      state
    ) as unknown as Ev[]
    expect(types(first)).toEqual(['message_start', 'content_block_start', 'content_block_delta'])
    expect((first[1] as { content_block: Ev }).content_block).toEqual({
      type: 'text',
      text: '',
      citations: null
    })
    expect((first[2] as { delta: Ev }).delta).toEqual({ type: 'text_delta', text: 'Hel' })

    const second = openAiChunkToEvents(
      { choices: [{ delta: { content: 'lo' } }] },
      state
    ) as unknown as Ev[]
    expect(types(second)).toEqual(['content_block_delta'])

    const last = openAiChunkToEvents(
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 }
      },
      state
    ) as unknown as Ev[]
    expect(types(last)).toEqual(['content_block_stop'])

    const end = openAiStreamEnd(state) as unknown as Ev[]
    expect(types(end)).toEqual(['message_delta', 'message_stop'])
    expect((end[0] as { delta: Ev }).delta).toEqual({
      stop_reason: 'end_turn',
      stop_sequence: null
    })
    expect((end[0] as { usage: Ev }).usage).toMatchObject({ input_tokens: 12, output_tokens: 3 })
  })

  it('assembles a tool call split over three chunks', () => {
    const state = openAiStreamState('gw-model')
    const all: Ev[] = []
    all.push(
      ...(openAiChunkToEvents(
        {
          id: 'c2',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'aggregate', arguments: '' }
                  }
                ]
              }
            }
          ]
        },
        state
      ) as unknown as Ev[])
    )
    all.push(
      ...(openAiChunkToEvents(
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '{"collection":' } }] } }
          ]
        },
        state
      ) as unknown as Ev[])
    )
    all.push(
      ...(openAiChunkToEvents(
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"regions"}' } }] },
              finish_reason: 'tool_calls'
            }
          ]
        },
        state
      ) as unknown as Ev[])
    )
    all.push(...(openAiStreamEnd(state) as unknown as Ev[]))
    expect(types(all)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    const message = assembleMessage(all as never) as unknown as Ev
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'aggregate', input: { collection: 'regions' } }
    ])
  })

  it('reads a tool call as tool_use when the gateway never sets finish_reason', () => {
    // Some gateways send `finish_reason: null` on EVERY chunk, the real stop
    // reason only in a vendor field — the blocks decide, or the loop reads
    // the tool round as the final answer and the reply comes back empty.
    const state = openAiStreamState('m')
    const all: Ev[] = []
    const chunks = [
      {
        choices: [
          {
            finish_reason: null,
            delta: {
              role: 'assistant',
              tool_calls: [{ id: 't1', index: 0, function: { name: 'aggregate', arguments: '' } }]
            }
          }
        ]
      },
      {
        choices: [
          {
            finish_reason: null,
            delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '{"a":1}' } }] }
          }
        ]
      },
      { choices: [{ finish_reason: null, delta: {} }] },
      {
        choices: [{ finish_reason: null, delta: {} }],
        usage: { prompt_tokens: 9, completion_tokens: 4 }
      }
    ]
    for (const c of chunks) all.push(...(openAiChunkToEvents(c as never, state) as unknown as Ev[]))
    all.push(...(openAiStreamEnd(state) as unknown as Ev[]))
    const message = assembleMessage(all as never) as unknown as Ev
    expect(message.stop_reason).toBe('tool_use')
    expect((message.usage as Ev).output_tokens).toBe(4)
    expect(message.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'aggregate', input: { a: 1 } }
    ])
  })

  it('a text-only answer with no finish_reason is still end_turn', () => {
    const state = openAiStreamState('m')
    const all: Ev[] = [
      ...(openAiChunkToEvents(
        { choices: [{ finish_reason: null, delta: { content: 'hi' } }] },
        state
      ) as unknown as Ev[]),
      ...(openAiStreamEnd(state) as unknown as Ev[])
    ]
    const message = assembleMessage(all as never) as unknown as Ev
    expect(message.stop_reason).toBe('end_turn')
  })

  it('closes the text block before a tool call starts', () => {
    const state = openAiStreamState('m')
    openAiChunkToEvents({ choices: [{ delta: { content: 'Let me check.' } }] }, state)
    const ev = openAiChunkToEvents(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_9', function: { name: 'query_items', arguments: '{}' } }
              ]
            }
          }
        ]
      },
      state
    ) as unknown as Ev[]
    expect(types(ev)).toEqual(['content_block_stop', 'content_block_start', 'content_block_delta'])
    expect((ev[0] as { index: number }).index).toBe(0)
    expect((ev[1] as { index: number }).index).toBe(1)
  })

  it('records usage from a chunk with no choices and reports it on the end', () => {
    const state = openAiStreamState('m')
    openAiChunkToEvents({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }, state)
    const tail = openAiChunkToEvents(
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 60 }
        }
      },
      state
    )
    expect(tail).toEqual([])
    const end = openAiStreamEnd(state) as unknown as Ev[]
    expect((end[0] as { usage: Ev }).usage).toEqual({
      input_tokens: 100,
      output_tokens: 7,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 60
    })
  })

  it('a stream with no finish reason still ends as end_turn with zero usage', () => {
    const state = openAiStreamState('m')
    openAiChunkToEvents({ choices: [{ delta: { content: 'partial' } }] }, state)
    const end = openAiStreamEnd(state) as unknown as Ev[]
    expect(types(end)).toEqual(['content_block_stop', 'message_delta', 'message_stop'])
    const m = assembleMessage([
      ...(openAiChunkToEvents({ choices: [] }, openAiStreamState('m')) as never[])
    ])
    expect((m as unknown as Ev).content).toEqual([])
  })
})

describe('assembleMessage', () => {
  it('equals the non-streamed shape for the same answer', () => {
    // the shape fromOpenAi() produces for a text + tool answer
    const whole = {
      id: 'chatcmpl-7',
      type: 'message',
      role: 'assistant',
      model: 'gw-model',
      content: [
        { type: 'text', text: 'Looking that up.', citations: null },
        {
          type: 'tool_use',
          id: 'call_a',
          name: 'query_items',
          input: { collection: 'vendors', limit: 5 }
        }
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        output_tokens: 11,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 20,
        server_tool_use: null,
        service_tier: null
      }
    }
    const state = openAiStreamState('gw-model')
    const events: Ev[] = [
      ...(openAiChunkToEvents(
        { id: 'chatcmpl-7', model: 'gw-model', choices: [{ delta: { content: 'Looking ' } }] },
        state
      ) as unknown as Ev[]),
      ...(openAiChunkToEvents(
        { choices: [{ delta: { content: 'that up.' } }] },
        state
      ) as unknown as Ev[]),
      ...(openAiChunkToEvents(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    function: { name: 'query_items', arguments: '{"collection":"vendors",' }
                  }
                ]
              }
            }
          ]
        },
        state
      ) as unknown as Ev[]),
      ...(openAiChunkToEvents(
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"limit":5}' } }] },
              finish_reason: 'tool_calls'
            }
          ]
        },
        state
      ) as unknown as Ev[]),
      ...(openAiChunkToEvents(
        {
          choices: [],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 11,
            prompt_tokens_details: { cached_tokens: 20 }
          }
        },
        state
      ) as unknown as Ev[]),
      ...(openAiStreamEnd(state) as unknown as Ev[])
    ]
    expect(assembleMessage(events as never)).toEqual(whole)
  })

  it('round-trips a whole message through eventsOfMessage', () => {
    const whole = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content: [{ type: 'text', text: 'Hello there', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: 'standard'
      }
    }
    expect(assembleMessage(eventsOfMessage(whole as never))).toEqual(whole)
  })

  it('exposes the text so far', () => {
    const a = createMessageAssembler()
    for (const e of openAiChunkToEvents(
      { choices: [{ delta: { content: 'ab' } }] },
      openAiStreamState('m')
    ))
      a.push(e)
    expect(a.text()).toBe('ab')
  })
})

describe('makeMessageStream', () => {
  it('yields events once, then resolves the assembled message and runs onFinal once', async () => {
    const whole = {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'x',
      content: [{ type: 'text', text: 'done', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: null
      }
    }
    let finals = 0
    const stream = makeMessageStream(
      (async function* () {
        for (const e of eventsOfMessage(whole as never)) yield e
      })(),
      () => undefined,
      { onFinal: () => finals++ }
    )
    const seen: string[] = []
    for await (const e of stream) seen.push((e as unknown as Ev).type as string)
    expect(seen).toContain('content_block_delta')
    expect(await stream.finalMessage()).toEqual(whole)
    expect(await stream.finalMessage()).toEqual(whole)
    expect(finals).toBe(1)
  })

  it('drains itself when only finalMessage is awaited', async () => {
    const whole = {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'x',
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {}
    }
    const stream = makeMessageStream(
      (async function* () {
        for (const e of eventsOfMessage(whole as never)) yield e
      })(),
      () => undefined
    )
    expect(((await stream.finalMessage()) as unknown as Ev).id).toBe('m')
  })

  it('reports an error once and rejects finalMessage', async () => {
    let errors = 0
    const stream = makeMessageStream(
      (async function* () {
        yield { type: 'message_start', message: {} } as never
        throw new Error('cut')
      })(),
      () => undefined,
      { onError: () => errors++ }
    )
    await expect(
      (async () => {
        for await (const _ of stream) {
          /* consume */
        }
      })()
    ).rejects.toThrow('cut')
    await expect(stream.finalMessage()).rejects.toThrow('cut')
    expect(errors).toBe(1)
  })

  it('hands onError the partial message a cut stream had assembled', async () => {
    let partial: Ev | null = null
    const stream = makeMessageStream(
      (async function* () {
        yield { type: 'message_start', message: { id: 'p', model: 'x' } } as never
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'half an ans' }
        } as never
        throw abortError()
      })(),
      () => undefined,
      { onError: (_err, m) => (partial = m as unknown as Ev) }
    )
    await expect(
      (async () => {
        for await (const _ of stream) {
          /* consume */
        }
      })()
    ).rejects.toThrow('stopped')
    expect(((partial as unknown as Ev)?.content as Ev[])[0]).toMatchObject({ text: 'half an ans' })
  })
})

describe('takeSseData', () => {
  it('returns complete data payloads and keeps the tail', () => {
    const { data, rest } = takeSseData('data: {"a":1}\n\n: comment\n\ndata: {"b"')
    expect(data).toEqual(['{"a":1}'])
    expect(rest).toBe('data: {"b"')
  })
  it('joins multi-line data and tolerates CRLF', () => {
    const { data } = takeSseData('event: x\r\ndata: one\r\ndata: two\r\n\r\n')
    expect(data).toEqual(['one\ntwo'])
  })
})
