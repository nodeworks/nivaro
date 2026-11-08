import { describe, expect, it } from 'vitest'
import { briefAgeText, briefDiffPair, briefLineKey } from './PipelinePanel'

describe('Submit confirm brief (army11 f4 M5)', () => {
  it('says the age in words, never "0d ago"', () => {
    expect(briefAgeText(0)).toBe('today')
    expect(briefAgeText(1)).toBe('1 day ago')
    expect(briefAgeText(12)).toBe('12 days ago')
  })
  it('cuts long values where they differ, so the change shows', () => {
    const a = 'ARMY11 Sudharsan f4 lock test A ARMY11 Sudharsan f4 lock test A S1 B'
    const b = `${a}4`
    const pair = briefDiffPair(a, b)
    expect(pair.old).not.toBe(pair.new)
    expect(pair.new.endsWith('B4')).toBe(true)
    expect(pair.old?.startsWith('…')).toBe(true)
  })
  it('keeps short values whole and names an empty one', () => {
    expect(briefDiffPair('', 'Yes')).toEqual({ old: '(empty)', new: 'Yes' })
    expect(briefDiffPair(undefined, 'x')).toEqual({ old: null, new: 'x' })
  })
  it('one forecast line, however it is punctuated in the two places', () => {
    expect(briefLineKey({ label: 'Forecast', text: 'Left $67 to forecast' })).toBe(
      briefLineKey({ label: 'Forecast ', text: 'Left $67 to forecast ' })
    )
  })
})
