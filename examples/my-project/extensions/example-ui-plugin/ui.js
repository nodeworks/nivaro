;(() => {
  var _NIVARO = window.__NIVARO__
  if (!_NIVARO) {
    console.error('[example-ui-plugin] window.__NIVARO__ not found — is Nivaro admin loaded?')
    return
  }

  var React = _NIVARO.React
  var useState = _NIVARO.useState

  function ExamplePanel(props) {
    var api = props.api
    var expanded = useState(false)
    var isExpanded = expanded[0]
    var setExpanded = expanded[1]

    return React.createElement(
      'div',
      {
        style: {
          marginTop: '20px',
          padding: '16px',
          border: '1px solid #e2e8f0',
          borderRadius: '8px',
          background: '#f8fafc'
        }
      },
      React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer'
          },
          onClick: () => {
            setExpanded(!isExpanded)
          }
        },
        React.createElement(
          'span',
          { style: { fontSize: '13px', fontWeight: '500', color: '#334155' } },
          'Example Plugin Panel'
        ),
        React.createElement(
          'span',
          { style: { fontSize: '11px', color: '#94a3b8' } },
          isExpanded ? 'Collapse' : 'Expand'
        )
      ),
      isExpanded &&
        React.createElement(
          'div',
          { style: { marginTop: '12px', fontSize: '13px', color: '#64748b' } },
          React.createElement('p', null, 'API: ' + api.name),
          React.createElement('p', null, 'Integration type: ' + (api.integration_type || 'none')),
          React.createElement(
            'p',
            { style: { marginTop: '8px', fontSize: '11px', color: '#94a3b8' } },
            'This panel is injected by the example-ui-plugin extension.'
          )
        )
    )
  }

  _NIVARO.registerPlugin({
    id: 'example-ui-plugin',
    name: 'Example UI Plugin',
    version: '1.0.0',
    slots: {
      'external-api-detail': {
        component: ExamplePanel
      }
    }
  })
})()
