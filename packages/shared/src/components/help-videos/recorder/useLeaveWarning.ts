import { useEffect } from 'react'

/** Stages in which leaving the page would drop parts not yet in the browser
 *  or on the server, or (`remote`, #1516) lose track of the recording window
 *  that will hand its video over. Never once the recording is saved, and
 *  never while the recorder is closed. */
export function leaveWarningActive(open: boolean, stage: string): boolean {
  return (
    open &&
    (stage === 'countdown' || stage === 'recording' || stage === 'saving' || stage === 'remote')
  )
}

/** Asks the browser to confirm leaving the page while `active`. */
export function useLeaveWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active])
}
