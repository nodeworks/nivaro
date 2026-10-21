import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ToolButton } from '../toolbar-kit'

/**
 * Theme preview (#2727): flip the canvas to the other theme without touching the
 * app's. Tailwind's dark variants follow an ancestor `.dark`, so a dark preview
 * inside a light app is exact (the canvas wrapper takes the class). The reverse
 * cannot be done by a descendant (an ancestor `.dark` cannot be switched off),
 * so inside a dark app the tool is off and says why.
 */

/** Is the app in dark theme right now (the `.dark` class on the root). */
const readDark = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

export function useAppIsDark(): boolean {
  const [dark, setDark] = useState(readDark)
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(readDark()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

/** The class the canvas wrapper takes: `dark` while the preview is on in a light app. */
export const previewThemeClass = (on: boolean, appDark: boolean): string =>
  on && !appDark ? 'dark' : ''

export function ThemePreviewTool({
  on,
  onChange,
  appDark,
  disabled
}: {
  on: boolean
  onChange: (on: boolean) => void
  appDark: boolean
  disabled?: boolean
}) {
  return (
    <ToolButton
      label='Preview in dark'
      icon={on ? <Sun className='h-3.5 w-3.5' /> : <Moon className='h-3.5 w-3.5' />}
      hint={
        appDark
          ? 'The app is already dark. Switch the app to light to preview the form in dark.'
          : 'Show the canvas in the dark theme; the app stays as it is'
      }
      checked={on && !appDark}
      disabled={disabled || appDark}
      onClick={() => onChange(!on)}
      data={{ 'data-editor-theme-preview': '' }}
    />
  )
}
