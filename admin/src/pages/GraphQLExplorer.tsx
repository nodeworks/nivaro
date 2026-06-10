import { GraphiQL } from 'graphiql'
import 'graphiql/style.css'
import { explorerPlugin } from '@graphiql/plugin-explorer'
import '@graphiql/plugin-explorer/style.css'
import { useMemo } from 'react'
import { useAuth } from '@/lib/auth'

export function GraphQLExplorerPage() {
  const { user } = useAuth()

  const explorer = useMemo(() => explorerPlugin({ showAttribution: false }), [])

  const fetcher = async (params: unknown) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (user?.static_token) headers.Authorization = `Bearer ${user.static_token}`
    const res = await fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(params)
    })
    return res.json()
  }

  return (
    <div className='h-full [&_.graphiql-container]:h-full [&_.graphiql-container]:rounded-none'>
      <GraphiQL
        fetcher={fetcher}
        plugins={[explorer]}
        defaultEditorToolsVisibility
        defaultQuery={`# Nivaro GraphQL API — authenticated as ${user?.email ?? 'you'}
#
# Example:
# { collections { data { id collection display_name } } }
`}
      />
    </div>
  )
}
