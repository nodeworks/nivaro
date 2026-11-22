import { afterEach, describe, expect, it } from 'vitest'
import {
  processFigureLabel,
  sharedProcessFlag
} from '../../../services/ops-report/process-label.js'

// Ruling P5-10 minor (review M4): on a shared deployment the daily operations report runs per
// app, but its memory and pool figures are the shared process's, which serves every app. They are
// labelled so. Self-hosted labels and digest JSON are unchanged.

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

describe('process figures in the daily report', () => {
  it('shared: labelled as the shared process and flagged in the digest', () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    delete process.env.CLOUD_META_DB_URL
    expect(processFigureLabel('Memory of the reporting process')).toBe(
      'Memory of the reporting process (the shared process, which serves every app)'
    )
    expect(sharedProcessFlag()).toEqual({ shared_process: true })
  })

  it('self-hosted and cloud: unchanged', () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    delete process.env.CLOUD_META_DB_URL
    expect(processFigureLabel('Request pool (max connections)')).toBe(
      'Request pool (max connections)'
    )
    expect(sharedProcessFlag()).toEqual({})
    process.env.CLOUD_META_DB_URL = 'postgres://meta/x'
    expect(sharedProcessFlag()).toEqual({})
  })
})
