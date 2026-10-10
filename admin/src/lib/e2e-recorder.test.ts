import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRecording,
  getRecorderState,
  loadRecordedSteps,
  type RecordedStep,
  renderSpec,
  setStepValue
} from './e2e-recorder'

/** Steps as POST /session-recordings/:id/spec answers them (#1393). */
const FROM_RECORDING: RecordedStep[] = [
  { kind: 'goto', path: '/orders/new', at: 1 },
  {
    kind: 'fill',
    selector: '[data-field="po_number"]',
    value: '<value for data-field="po_number">',
    label: 'po_number',
    at: 2
  },
  {
    kind: 'click',
    selector: 'button:has-text("Save order")',
    role: { role: 'button', name: 'Save order' },
    label: 'Save order',
    at: 3
  },
  { kind: 'click', selector: '[data-action="undo"]', label: 'Undo', at: 4 }
]

afterEach(() => clearRecording())

describe('steps from a session recording (#1393)', () => {
  it('render in the golden-path style: data-* locators, getByRole, placeholders', () => {
    const spec = renderSpec({
      name: 'replay-6f1c2b3a',
      title: "Replay of Ada's session",
      origin: 'http://localhost:3057',
      steps: FROM_RECORDING,
      viewport: { width: 1440, height: 900 }
    })
    expect(spec).toContain('test.describe("Replay of Ada\'s session"')
    expect(spec).toContain('viewport: { width: 1440, height: 900 }')
    expect(spec).toContain('await page.goto(`${ORIGIN}/orders/new`)')
    expect(spec).toContain(
      'await page.locator("[data-field=\\"po_number\\"]").first().fill("<value for data-field=\\"po_number\\">")'
    )
    expect(spec).toContain(
      'await page.getByRole("button", { name: "Save order", exact: true }).first().click()'
    )
    expect(spec).toContain('await page.locator("[data-action=\\"undo\\"]").first().click()')
  })

  it('load into the recorder as a draft with their source, and values can be filled in', () => {
    loadRecordedSteps(FROM_RECORDING, {
      viewport: { width: 1440, height: 900 },
      source: {
        recordingId: 'r1',
        fromMs: 0,
        toMs: 5000,
        name: 'replay-r1',
        title: 'Replay',
        placeholders: 1,
        unresolved: 0
      }
    })
    const s = getRecorderState()
    expect(s.recording).toBe(false)
    expect(s.steps).toHaveLength(4)
    expect(s.viewport).toEqual({ width: 1440, height: 900 })
    expect(s.source?.recordingId).toBe('r1')
    setStepValue(1, 'PO-1001')
    expect(getRecorderState().steps[1]).toMatchObject({ kind: 'fill', value: 'PO-1001' })
    // Only fill / select steps take a value.
    setStepValue(2, 'nope')
    expect(getRecorderState().steps[2]).not.toHaveProperty('value')
  })
})
