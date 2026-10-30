import { Component, type ReactNode } from 'react'

/** One section failing to draw says so in its own place; the rest of the Overview carries on. */
export class SectionBoundary extends Component<
  { title: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(err: unknown) {
    // biome-ignore lint/suspicious/noConsole: the one trace a broken section leaves
    console.warn('[overview] a section failed to draw', err)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div
        role='status'
        className='rounded-lg border border-slate-200 bg-white px-4 py-3 text-[12.5px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
      >
        {this.props.title} could not be shown.{' '}
        <button
          type='button'
          className='font-medium text-slate-900 underline underline-offset-2 dark:text-white'
          onClick={() => this.setState({ failed: false })}
        >
          Try again
        </button>
      </div>
    )
  }
}
