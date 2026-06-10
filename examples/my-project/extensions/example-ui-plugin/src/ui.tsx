import type { ExternalApiSlotContext, NivaroExtensionPlugin } from '@nivaro/sdk'
import React, { useState } from 'react'

function ExamplePanel({ api }: { api: ExternalApiSlotContext }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      style={{
        marginTop: 20,
        padding: 16,
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        background: '#f8fafc'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer'
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ fontSize: 13, fontWeight: 500, color: '#334155' }}>
          Example Plugin Panel
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{expanded ? 'Collapse' : 'Expand'}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, fontSize: 13, color: '#64748b' }}>
          <p>API: {api.name}</p>
          <p>Integration type: {api.integration_type ?? 'none'}</p>
          <p style={{ marginTop: 8, fontSize: 11, color: '#94a3b8' }}>
            This panel is injected by the example-ui-plugin extension.
          </p>
        </div>
      )}
    </div>
  )
}

const plugin: NivaroExtensionPlugin = {
  id: 'example-ui-plugin',
  name: 'Example UI Plugin',
  version: '1.0.0',
  slots: {
    'external-api-detail': {
      component: ExamplePanel as unknown as never
    }
  }
}

window.__NIVARO__.registerPlugin(plugin)
