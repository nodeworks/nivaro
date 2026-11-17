import { describe, expect, it } from 'vitest'
import { editorJsToHtml, editorJsToText, isEditorJsValue } from './editorjs'

const doc = {
  time: 1639447000063,
  blocks: [
    { id: 'a', type: 'paragraph', data: { text: 'Winning Bid: <b>Acme</b> &amp; Co' } },
    { id: 'b', type: 'list', data: { style: 'unordered', items: ['Batteries', 'HVAC'] } },
    { id: 'c', type: 'list', data: { style: 'ordered', items: [{ content: 'First', items: [] }] } }
  ]
}

describe('Editor.js values', () => {
  it('recognises the document as JSON text or as an object, nothing else', () => {
    expect(isEditorJsValue(JSON.stringify(doc))).toBe(true)
    expect(isEditorJsValue(doc)).toBe(true)
    expect(isEditorJsValue('{"a":1}')).toBe(false)
    expect(isEditorJsValue('<p>hi</p>')).toBe(false)
    expect(isEditorJsValue(42)).toBe(false)
  })

  it('reads as text: a line per block, bullets and numbers kept, no tags', () => {
    expect(editorJsToText(JSON.stringify(doc))).toBe(
      'Winning Bid: Acme & Co\n• Batteries\n• HVAC\n1. First'
    )
  })

  it('renders HTML from an object as well as from text', () => {
    expect(editorJsToHtml(doc)).toContain('<ul><li>Batteries</li><li>HVAC</li></ul>')
    expect(editorJsToHtml(JSON.stringify(doc))).toBe(editorJsToHtml(doc))
  })
})
