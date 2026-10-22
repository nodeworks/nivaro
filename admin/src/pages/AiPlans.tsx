import { createNivaro } from '@nivaro/sdk'
import { type AiPlanSubscribe, AiPlansView, NivaroProvider } from '@nivaro/shared'
import { useSearchParams } from 'react-router'
import { useAuth } from '@/lib/auth'
import { getSocket } from '@/lib/socket'

// Ask AI plans outside the chat (#1954, #1952): history with the change
// report, undo and "make a draft flow" (admins), plus plan templates.
// ?plan=<id> selects a plan — plan notifications (#2004) link here.
const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

const subscribePlan: AiPlanSubscribe = (event, handler) => {
  const s = getSocket()
  s.on(event, handler)
  return () => {
    s.off(event, handler)
  }
}

export function AiPlansPage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  return (
    <NivaroProvider client={sharedClient}>
      <AiPlansView
        isAdmin={!!user?.is_admin}
        planId={params.get('plan')}
        onSelectPlan={(id) => {
          const next = new URLSearchParams(params)
          if (id) next.set('plan', id)
          else next.delete('plan')
          setParams(next, { replace: true })
        }}
        subscribe={subscribePlan}
      />
    </NivaroProvider>
  )
}
