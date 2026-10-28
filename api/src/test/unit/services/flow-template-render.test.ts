import { describe, expect, it } from 'vitest'
import {
  isRichTextField,
  resolveBodyTemplate,
  resolveHtmlTemplate,
  resolveJsonTemplate,
  resolveTemplate,
  resolveUrlTemplate
} from '../../../services/flow-template-render.js'

const data = {
  $data: {
    name: 'Kim "K" Lee',
    note: 'x", "admin": true, "y": "',
    amount: 12.5,
    count: 3,
    ok: true,
    missing: null,
    lines: [{ sku: 'A1', qty: 2 }],
    json_text: '{"po":"PO-1","total":5}',
    numeric_text: '42',
    id: '7/../../admin?x=1&y=2',
    host: 'partner.example.com',
    base: 'https://partner.example.com/api',
    html: '<img src=x onerror=alert(1)>',
    rich: '<b>bold</b>'
  },
  record: { 'creator.email': 'a@b.co' }
}

describe('resolveTemplate (plain text) — unchanged', () => {
  it('substitutes text and blanks missing values', () => {
    expect(resolveTemplate('Hi {{ $data.name }} {{$data.missing}}!', data)).toBe('Hi Kim "K" Lee !')
    expect(resolveTemplate('{{record.creator.email}}', data)).toBe('a@b.co')
  })
})

describe('resolveJsonTemplate (M26)', () => {
  it('a value inside a string literal cannot close the string', () => {
    const out = resolveJsonTemplate('{"note": "{{$data.note}}", "name": "{{$data.name}}"}', data)
    expect(JSON.parse(out)).toEqual({ note: data.$data.note, name: data.$data.name })
    expect(JSON.parse(out).admin).toBeUndefined()
  })

  it('a value outside quotes is one JSON value', () => {
    const out = resolveJsonTemplate(
      '{"amount": {{$data.amount}}, "count": {{$data.count}}, "ok": {{$data.ok}}, "none": {{$data.missing}}, "lines": {{$data.lines}}, "name": {{$data.name}}}',
      data
    )
    expect(JSON.parse(out)).toEqual({
      amount: 12.5,
      count: 3,
      ok: true,
      none: null,
      lines: [{ sku: 'A1', qty: 2 }],
      name: 'Kim "K" Lee'
    })
  })

  it('keeps templates that build objects from a JSON value carried as text', () => {
    const out = resolveJsonTemplate(
      '{"order": {{$data.json_text}}, "n": {{$data.numeric_text}}}',
      data
    )
    expect(JSON.parse(out)).toEqual({ order: { po: 'PO-1', total: 5 }, n: 42 })
  })

  it('a value outside quotes cannot add keys', () => {
    const out = resolveJsonTemplate('{"a": {{$data.note}}}', data)
    expect(Object.keys(JSON.parse(out))).toEqual(['a'])
  })

  it('leaves escaped quotes in the template alone', () => {
    const out = resolveJsonTemplate(
      '{"q": "say \\"{{$data.count}}\\" now", "n": {{$data.count}}}',
      data
    )
    expect(JSON.parse(out)).toEqual({ q: 'say "3" now', n: 3 })
  })

  it('renders safe values exactly as before', () => {
    const tpl = '{"po": "{{$data.host}}", "qty": {{$data.count}}, "ok": {{$data.ok}}}'
    expect(resolveJsonTemplate(tpl, data)).toBe(resolveTemplate(tpl, data))
  })
})

describe('resolveUrlTemplate (M26)', () => {
  it('percent-encodes values in the path and query', () => {
    expect(resolveUrlTemplate('https://x.example/items/{{$data.id}}?n={{$data.name}}', data)).toBe(
      'https://x.example/items/7%2F..%2F..%2Fadmin%3Fx%3D1%26y%3D2?n=Kim%20%22K%22%20Lee'
    )
  })

  it('keeps a placeholder that supplies the host or the whole origin', () => {
    expect(resolveUrlTemplate('https://{{$data.host}}/hook/{{$data.count}}', data)).toBe(
      'https://partner.example.com/hook/3'
    )
    expect(resolveUrlTemplate('{{$data.base}}/orders/{{$data.id}}', data)).toBe(
      'https://partner.example.com/api/orders/7%2F..%2F..%2Fadmin%3Fx%3D1%26y%3D2'
    )
  })

  it('a relative path override encodes every value but a leading one', () => {
    expect(resolveUrlTemplate('/orders/{{$data.id}}', data)).toBe(
      '/orders/7%2F..%2F..%2Fadmin%3Fx%3D1%26y%3D2'
    )
  })

  it('leaves safe values unchanged', () => {
    const tpl = 'https://x.example/a/{{$data.count}}?h={{$data.host}}'
    expect(resolveUrlTemplate(tpl, data)).toBe(resolveTemplate(tpl, data))
  })

  // review A4: placeholders that fill a whole part keep working
  const parts = {
    base: 'https://p.example',
    path: '/api/v2/orders?full=1',
    rel: 'api/v2/orders',
    qs: 'a=1&b=two',
    key: 'k&x',
    val: 'v w&z=1'
  }
  it('a placeholder right after the origin is the whole path, as is', () => {
    expect(resolveUrlTemplate('{{base}}{{path}}', parts)).toBe(
      'https://p.example/api/v2/orders?full=1'
    )
  })

  it('a whole query part is as is; keys and values inside one are encoded', () => {
    expect(resolveUrlTemplate('https://h.example/x?{{qs}}', parts)).toBe(
      'https://h.example/x?a=1&b=two'
    )
    expect(resolveUrlTemplate('https://h.example/x?z=1&{{qs}}#f', parts)).toBe(
      'https://h.example/x?z=1&a=1&b=two#f'
    )
    expect(resolveUrlTemplate('https://h.example/x?{{key}}={{val}}', parts)).toBe(
      'https://h.example/x?k%26x=v%20w%26z%3D1'
    )
  })

  it('a whole path after the root slash keeps its slashes, segments encoded', () => {
    expect(resolveUrlTemplate('https://h.example/{{rel}}?q={{val}}', parts)).toBe(
      'https://h.example/api/v2/orders?q=v%20w%26z%3D1'
    )
    expect(resolveUrlTemplate('/{{$data.id}}', data)).toBe('/7/../../admin%3Fx%3D1%26y%3D2')
  })

  it('| raw opts one placeholder out anywhere', () => {
    expect(resolveUrlTemplate('https://h.example/a/{{ val | raw }}', parts)).toBe(
      'https://h.example/a/v w&z=1'
    )
  })
})

describe('resolveHtmlTemplate (mail body)', () => {
  it('rich-text fields are sanitized, not escaped (review A5)', () => {
    const rec = {
      body: '<p class="x" onclick="steal()">Hi <b>there</b><script>alert(1)</script></p>',
      link: '<a href="javascript:alert(1)">x</a><a href="https://ok.example/?a=1&amp;b=2">y</a>',
      broken: '<img src=x onerror=alert(1)',
      plain: '<b>not rich</b>'
    }
    const rich = new Set(['body', 'link', 'broken'])
    expect(
      resolveHtmlTemplate('<div>{{$data.body}}</div>', { $data: rec }, { richFields: rich })
    ).toBe('<div><p>Hi <b>there</b></p></div>')
    expect(resolveHtmlTemplate('{{link}}', rec, { richFields: rich })).toBe(
      '<a rel="noopener noreferrer" target="_blank">x</a>' +
        '<a href="https://ok.example/?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">y</a>'
    )
    // a scheme hidden behind character references is still refused
    expect(
      resolveHtmlTemplate(
        '{{x}}',
        { x: '<a href="java&#115;cript&colon;alert(1)">z</a>' },
        {
          richFields: new Set(['x'])
        }
      )
    ).toBe('<a rel="noopener noreferrer" target="_blank">z</a>')
    // a half-written tag can never open one with the template's next tag
    expect(resolveHtmlTemplate('<p>{{broken}}</p>', rec, { richFields: rich })).toBe(
      '<p>&lt;img src=x onerror=alert(1)</p>'
    )
    expect(resolveHtmlTemplate('{{plain}}', rec, { richFields: rich })).toBe(
      '&lt;b&gt;not rich&lt;/b&gt;'
    )
  })

  it('knows rich-text fields by interface or type', () => {
    expect(isRichTextField({ type: 'text', interface: 'input-rich-text-html' })).toBe(true)
    expect(isRichTextField({ type: 'wysiwyg', interface: null })).toBe(true)
    expect(isRichTextField({ type: 'text', interface: 'input-multiline' })).toBe(false)
  })

  it('escapes values; | raw opts one out', () => {
    expect(
      resolveHtmlTemplate('<p>{{$data.html}}</p><div>{{ $data.rich | raw }}</div>', data)
    ).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p><div><b>bold</b></div>')
  })
})

describe('resolveBodyTemplate', () => {
  it('picks the renderer by content type', () => {
    expect(resolveBodyTemplate('a={{$data.name}}', data, 'application/x-www-form-urlencoded')).toBe(
      'a=Kim%20%22K%22%20Lee'
    )
    expect(resolveBodyTemplate('<n>{{$data.html}}</n>', data, 'application/xml')).toBe(
      '<n>&lt;img src=x onerror=alert(1)&gt;</n>'
    )
    expect(resolveBodyTemplate('{"n":"{{$data.note}}"}', data, null)).toBe(
      resolveJsonTemplate('{"n":"{{$data.note}}"}', data)
    )
    expect(resolveBodyTemplate('n={{$data.name}}', data, 'text/plain')).toBe('n=Kim "K" Lee')
  })
})
