import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildPipelineDiagram } from '@/lib/diagram/pipeline-diagram'
import { DiagramOutline } from './DiagramOutline'
import { DiagramTabs } from './DiagramTabs'
import { DiagramViewer } from './DiagramViewer'

const diagram = buildPipelineDiagram({
  states: [
    { id: 'a', key: 'A', label: 'Draft', color: '#3b82f6', is_initial: true, is_terminal: false },
    { id: 'b', key: 'B', label: 'Done', color: null, is_initial: false, is_terminal: true }
  ],
  transitions: [{ id: 't', from_state: 'a', to_state: 'b', label: 'Finish', required_roles: null }]
})

describe('diagram components', () => {
  it('renders the svg with both boxes and zoom controls', () => {
    const { container } = render(<DiagramViewer diagram={diagram} title='Test' filename='t' />)
    expect(container.querySelectorAll('[data-node]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(1)
    expect(container.textContent).toContain('Finish')
    const before = screen.getByText(/%$/).textContent
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(screen.getByText(/%$/).textContent).not.toBe(before)
  })

  it('zooms with the keyboard', () => {
    render(<DiagramViewer diagram={diagram} title='Test' filename='t' />)
    const before = screen.getByText(/%$/).textContent
    fireEvent.keyDown(screen.getByRole('application'), { key: '+' })
    expect(screen.getByText(/%$/).textContent).not.toBe(before)
  })

  it('stacks into an outline list', () => {
    render(<DiagramOutline diagram={diagram} />)
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Finish')).toBeTruthy()
  })

  it('switches tabs', () => {
    let v = 'editor'
    render(<DiagramTabs value='editor' onChange={(x) => (v = x)} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Diagram' }))
    expect(v).toBe('diagram')
  })
})
