import { describe, expect, it } from 'vitest'
import { emptyEdits, type VideoEdits } from '../../../services/help-video-edits.js'
import {
  clockTime,
  excerpt,
  momentPath,
  rankHelpVideoHits,
  type SearchableVideo,
  searchTerms
} from '../../../services/help-video-search-rank.js'

const ID = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
const edits = (over: Partial<VideoEdits> = {}): VideoEdits => ({ ...emptyEdits(120_000), ...over })
const video = (n: number, over: Partial<SearchableVideo> = {}): SearchableVideo => ({
  id: ID(n),
  title: `Video ${n}`,
  description: null,
  category: null,
  edits: edits(),
  ...over
})

describe('searchTerms', () => {
  it('drops stop words, stems, dedupes', () => {
    expect(searchTerms('How do I submit to the warehouses?')).toEqual(['submit', 'warehous'])
    expect(searchTerms('Submitting submits')).toEqual(['submit'])
    expect(searchTerms('   ')).toEqual([])
    expect(searchTerms('approve')).toEqual(['approv'])
    expect(searchTerms('Step 2 a')).toEqual(['step', '2'])
  })
  it('a word finds its other forms', () => {
    const [hit] = rankHelpVideoHits(
      [video(1, { title: 'Approving a Workflow' })],
      'approve workflows'
    )
    expect(hit?.match).toBe('title')
    expect(hit?.cite).toBe(`[Watch Approving a Workflow](/help-videos?watch=${ID(1)}&t=0)`)
  })
  it('keeps stop words when the query is nothing else', () => {
    expect(searchTerms('how to')).toEqual(['how', 'to'])
  })
})

describe('rankHelpVideoHits', () => {
  it('ranks title > chapter > caption > description', () => {
    const vids = [
      video(1, { description: 'Explains how to submit to the warehouse' }),
      video(2, {
        edits: edits({
          captions: [
            { id: 'c1', start_ms: 30_000, end_ms: 33_000, text: 'now submit to the warehouse' }
          ]
        })
      }),
      video(3, {
        edits: edits({ chapters: [{ id: 'ch1', at_ms: 10_000, title: 'Submit to warehouse' }] })
      }),
      video(4, { title: 'How to submit to warehouse' })
    ]
    const hits = rankHelpVideoHits(vids, 'submit warehouse')
    expect(hits.map((h) => h.match)).toEqual(['title', 'chapter', 'caption', 'description'])
    expect(hits.map((h) => h.id)).toEqual([ID(4), ID(3), ID(2), ID(1)])
  })

  it('puts every-word matches before partial ones', () => {
    const hits = rankHelpVideoHits(
      [
        video(1, { title: 'Warehouse basics' }),
        video(2, {
          edits: edits({
            captions: [
              { id: 'c', start_ms: 5000, end_ms: 6000, text: 'submit the warehouse order' }
            ]
          })
        })
      ],
      'submit warehouse'
    )
    expect(hits[0].id).toBe(ID(2))
    expect(hits[1].match).toBe('title')
  })

  it('cites the chapter moment in edited time with the chapter id', () => {
    const e = edits({
      intro: { enabled: true, duration_ms: 3000, show_chapters: false, title: '', subtitle: '' },
      segments: [
        { start_ms: 0, end_ms: 20_000, speed: 1 },
        { start_ms: 40_000, end_ms: 120_000, speed: 2 }
      ],
      chapters: [{ id: 'ch9', at_ms: 60_000, title: 'Approve the order' }]
    })
    const [hit] = rankHelpVideoHits([video(7, { title: 'Orders', edits: e })], 'approve')
    // 3 s intro + 20 s first piece + (60 - 40) s at 2x = 33 s
    expect(hit.t).toBe(33)
    expect(hit.at).toBe('0:33')
    expect(hit.chapter_id).toBe('ch9')
    expect(hit.path).toBe(`/help-videos?watch=${ID(7)}&t=33&c=ch9`)
    expect(hit.cite).toBe(`[Watch 0:33 of Orders](/help-videos?watch=${ID(7)}&t=33&c=ch9)`)
  })

  it('skips chapters and captions inside a cut; a caption starting in a cut uses its kept part', () => {
    const e = edits({
      segments: [
        { start_ms: 0, end_ms: 10_000, speed: 1 },
        { start_ms: 20_000, end_ms: 120_000, speed: 1 }
      ],
      chapters: [{ id: 'gone', at_ms: 15_000, title: 'Export the report' }],
      captions: [
        { id: 'a', start_ms: 12_000, end_ms: 14_000, text: 'export cut away' },
        { id: 'b', start_ms: 18_000, end_ms: 25_000, text: 'export the file' }
      ]
    })
    const [hit] = rankHelpVideoHits([video(1, { edits: e })], 'export')
    expect(hit.match).toBe('caption')
    expect(hit.moments.map((m) => m.t)).toEqual([10])
  })

  it('matches a phrase split across two captions', () => {
    const e = edits({
      captions: [
        { id: 'a', start_ms: 42_000, end_ms: 44_000, text: 'then click submit' },
        { id: 'b', start_ms: 44_000, end_ms: 46_000, text: 'to the warehouse' }
      ]
    })
    const [hit] = rankHelpVideoHits([video(1, { edits: e })], 'submit warehouse')
    expect(hit.t).toBe(42)
    expect(hit.moments[0].full).toBe(true)
    expect(hit.snippet).toBe('then click submit to the warehouse')
  })

  it('a title match borrows a full moment for its link, else opens at 0:00', () => {
    const withMoment = video(1, {
      title: 'Submit to warehouse',
      edits: edits({
        captions: [{ id: 'a', start_ms: 7000, end_ms: 9000, text: 'submit to the warehouse here' }]
      })
    })
    const plain = video(2, { title: 'Submit to warehouse [old]' })
    const hits = rankHelpVideoHits([withMoment, plain], 'submit warehouse')
    const a = hits.find((h) => h.id === ID(1))
    const b = hits.find((h) => h.id === ID(2))
    expect(a?.t).toBe(7)
    expect(b?.t).toBe(0)
    // Brackets cannot ride a markdown link label.
    expect(b?.cite).toBe(`[Watch Submit to warehouse (old)](/help-videos?watch=${ID(2)}&t=0)`)
  })

  it('caps results and ignores videos that do not match', () => {
    const vids = Array.from({ length: 12 }, (_, i) => video(i, { title: `Order help ${i}` }))
    vids.push(video(99, { title: 'Unrelated' }))
    expect(rankHelpVideoHits(vids, 'order')).toHaveLength(5)
    expect(rankHelpVideoHits(vids, 'order', 50)).toHaveLength(8)
    expect(rankHelpVideoHits(vids, 'nothing here')).toEqual([])
  })
})

describe('excerpt + clock', () => {
  it('cuts long text around the first matched word', () => {
    const long = `${'lorem ipsum '.repeat(30)}submit the order ${'dolor sit '.repeat(30)}`
    const s = excerpt(long, ['submit'])
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(s).toContain('submit the order')
    expect(s.length).toBeLessThanOrEqual(162)
  })
  it('formats clock times and paths', () => {
    expect(clockTime(42)).toBe('0:42')
    expect(clockTime(3725)).toBe('1:02:05')
    expect(momentPath('ABC', 5)).toBe('/help-videos?watch=abc&t=5')
  })
})
