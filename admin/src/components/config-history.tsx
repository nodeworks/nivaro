import { createNivaro } from '@nivaro/sdk'
import {
  NivaroProvider,
  ConfigHistory as SharedConfigHistory,
  ConfigHistoryButton as SharedConfigHistoryButton
} from '@nivaro/shared'
import type { ComponentProps } from 'react'

/**
 * #12 — the shared config History (packages/shared ConfigHistory) for admin screens, which are
 * not all inside a NivaroProvider. One client for every screen that shows it.
 */
const historyClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

export function ConfigHistoryButton(props: ComponentProps<typeof SharedConfigHistoryButton>) {
  return (
    <NivaroProvider client={historyClient}>
      <SharedConfigHistoryButton {...props} />
    </NivaroProvider>
  )
}

export function ConfigHistory(props: ComponentProps<typeof SharedConfigHistory>) {
  return (
    <NivaroProvider client={historyClient}>
      <SharedConfigHistory {...props} />
    </NivaroProvider>
  )
}
