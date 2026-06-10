import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { authenticate } from '../middleware/authenticate.js'
import { buildOpenAPISpec } from '../services/schema-builder.js'

export async function schemaRoutes(app: FastifyInstance) {
  // OpenAPI 3.1 JSON spec — always fresh (queries nivaro_collections/fields each time)
  app.get('/schema.json', async (req, reply) => {
    const baseUrl = `${req.protocol}://${req.hostname}${config.PORT !== 443 && config.PORT !== 80 ? `:${config.PORT}` : ''}`
    const spec = await buildOpenAPISpec(baseUrl)
    return reply
      .header('Content-Type', 'application/json')
      .header('Access-Control-Allow-Origin', '*')
      .send(spec)
  })

  // Swagger UI — session cookie populates req.user; ?token= kept as fallback for external tools
  app.get('/schema', { preHandler: authenticate }, async (req, reply) => {
    // Prefer session-derived token (never in URL) over explicit ?token= (external SDK use only)
    const sessionToken = req.user?.static_token ?? null
    const raw = sessionToken ?? (req.query as Record<string, string>).token ?? ''
    // Allowlist: only RFC 6750 token chars — blocks all script-breakout vectors before JSON.stringify
    if (raw && !/^[A-Za-z0-9._~+/=-]{1,512}$/.test(raw)) {
      return reply.code(400).send({ error: 'Invalid token' })
    }
    const safeToken = raw || null
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nivaro API Reference</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.32.6/swagger-ui.css" integrity="sha384-9Q2fpS+xeS4ffJy6CagnwoUl+4ldAYhOs9pgZuEKxypVModhmZFzeMlvVsAjf7uT" crossorigin="anonymous" />
  <style>
    body { margin: 0; }
    .swagger-ui .topbar { background: #172940; }
    .swagger-ui .topbar .download-url-wrapper { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.32.6/swagger-ui-bundle.js" integrity="sha384-EYdOaiRwn44zNjrw+Tfs06qYz9BGQVo2f4/pLY5i7VorbjnZNhdplAbTBk8FXHUJ" crossorigin="anonymous"></script>
  <script>
    const token = ${JSON.stringify(safeToken)};
    const ui = SwaggerUIBundle({
      url: '/api/schema.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
      tryItOutEnabled: true,
      persistAuthorization: true,
      requestInterceptor: (req) => {
        req.credentials = 'include';
        if (token) req.headers['Authorization'] = 'Bearer ' + token;
        return req;
      },
      onComplete: () => {
        if (!token) return;
        try {
          ui.authActions.authorize({
            bearerToken: {
              name: 'bearerToken',
              schema: { type: 'http', scheme: 'bearer', description: 'Static token' },
              value: token,
            },
          });
        } catch (_) {}
      },
    });
  </script>
</body>
</html>`
    return reply.type('text/html').send(html)
  })
}
