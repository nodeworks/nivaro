import { describe, expect, it } from 'vitest'
import { ConfigError, loadAgentConfig, parseListen } from '../src/config.js'

const TOKEN = 'abcdefghij'.repeat(4)
const HMAC = 'HMACkey-0123456789-HMACkey-0123456789'
const DIGEST = 'a'.repeat(64)

function files(map: Record<string, string>) {
  return (p: string) => {
    if (p in map) return map[p]
    const err: NodeJS.ErrnoException = new Error('ENOENT')
    err.code = 'ENOENT'
    throw err
  }
}

const baseFiles = { '/run/secrets/token': `  ${TOKEN}\n` }
const traefikEnv = {
  HUB_AGENT_TOKEN_FILE: '/run/secrets/token',
  HUB_AGENT_EDGE_NETWORK: 'edge',
  HUB_AGENT_HOST_SUFFIXES: '.apps.corp'
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError)
    // The message is the code alone, never a value.
    expect((err as Error).message).toBe((err as ConfigError).code)
    return (err as ConfigError).code
  }
}

describe('loadAgentConfig', () => {
  it('reads and trims the token from its file', () => {
    const cfg = loadAgentConfig(traefikEnv, files(baseFiles))
    expect(cfg.token).toBe(TOKEN)
    expect(cfg.hmacKey).toBe(TOKEN)
  })

  it('applies the defaults', () => {
    const cfg = loadAgentConfig(traefikEnv, files(baseFiles))
    expect(cfg.listen).toBe('127.0.0.1:7480')
    expect(cfg.tls).toBeUndefined()
    expect(cfg.socket).toBe('/var/run/docker.sock')
    expect(cfg.images).toEqual(['nodeworks/nivaro'])
    expect(cfg.edge).toBe('traefik')
    expect(cfg.edgeNetwork).toBe('edge')
    expect(cfg.entrypoints).toEqual(['websecure'])
    expect(cfg.certResolver).toBeUndefined()
    expect(cfg.hostSuffixes).toEqual(['.apps.corp'])
    expect(cfg.publishPorts).toBeNull()
    expect(cfg.redisImage).toBeNull()
    expect(cfg.volumeDriver).toBe('local')
    expect(cfg.volumeOpts).toEqual({})
    expect(cfg.extensionsRoot).toBe('/var/lib/nivaro-hub-agent/extensions')
    expect(cfg.extensionsHostRoot).toBe('/var/lib/nivaro-hub-agent/extensions')
    expect(cfg.extensionsShared).toBe(false)
    expect(cfg.registryAuth).toBeNull()
    expect(cfg.envPrefixes).toEqual([])
  })

  it('reads HUB_AGENT_ENV_PREFIXES (ruling P4-23)', () => {
    const cfg = loadAgentConfig(
      { ...traefikEnv, HUB_AGENT_ENV_PREFIXES: ' EFP_, ACME2_ ,EFP_,EFP_OPS_,A_B2_C_' },
      files(baseFiles)
    )
    expect(cfg.envPrefixes).toEqual(['EFP_', 'ACME2_', 'EFP_OPS_', 'A_B2_C_'])
  })

  it.each([
    'GIO_',
    'GTK_',
    'GST_',
    'GST_PLUGIN_X_',
    'LD_',
    'NODE_',
    'NIVARO_',
    'MESA_',
    'QT_',
    'HELP_',
    'PATH_'
  ])('refuses the env prefix %j that overlaps the deny rules (ENV_PREFIX_DENIED)', (p) => {
    expect(
      codeOf(() =>
        loadAgentConfig({ ...traefikEnv, HUB_AGENT_ENV_PREFIXES: `EFP_,${p}` }, files(baseFiles))
      )
    ).toBe('ENV_PREFIX_DENIED')
  })

  it.each([
    'efp_',
    'EFP',
    'EFP-',
    '_',
    '1EFP_',
    'EF P_',
    'EFP__X',
    'EFP__',
    'EFP_x_'
  ])('refuses the env prefix %j (ENV_PREFIXES_BAD)', (p) => {
    expect(
      codeOf(() => loadAgentConfig({ ...traefikEnv, HUB_AGENT_ENV_PREFIXES: p }, files(baseFiles)))
    ).toBe('ENV_PREFIXES_BAD')
  })

  it('reads every optional setting', () => {
    const cfg = loadAgentConfig(
      {
        ...traefikEnv,
        HUB_AGENT_HMAC_KEY_FILE: '/run/secrets/hmac',
        HUB_AGENT_LISTEN: '127.0.0.1:7481',
        HUB_AGENT_TLS_CERT_FILE: '/tls/cert.pem',
        HUB_AGENT_TLS_KEY_FILE: '/tls/key.pem',
        HUB_AGENT_DOCKER_SOCKET: '/tmp/docker.sock',
        HUB_AGENT_IMAGES: 'nodeworks/nivaro, registry.corp:5000/team/nivaro-ext',
        HUB_AGENT_ENTRYPOINTS: 'web,websecure',
        HUB_AGENT_CERT_RESOLVER: 'le',
        HUB_AGENT_HOST_SUFFIXES: 'apps.corp, .Other.Corp',
        HUB_AGENT_REDIS_IMAGE: `redis@sha256:${DIGEST}`,
        HUB_AGENT_VOLUME_DRIVER: 'nfs',
        HUB_AGENT_VOLUME_OPTS_FILE: '/run/secrets/vol',
        HUB_AGENT_EXTENSIONS_ROOT: '/data/ext',
        HUB_AGENT_EXTENSIONS_HOST_ROOT: '/srv/ext',
        HUB_AGENT_EXTENSIONS_SHARED: 'on',
        HUB_AGENT_REGISTRY_AUTH_FILE: '/run/secrets/docker.json'
      },
      files({
        ...baseFiles,
        '/run/secrets/hmac': `${HMAC}\n`,
        '/tls/cert.pem': 'CERT',
        '/tls/key.pem': 'KEY',
        '/run/secrets/vol': '{"type":"nfs","o":"addr=10.0.0.5"}',
        '/run/secrets/docker.json': '{"auths":{"registry.corp:5000":{"auth":"dTpw"}}}'
      })
    )
    expect(cfg.hmacKey).toBe(HMAC)
    expect(cfg.listen).toBe('127.0.0.1:7481')
    expect(cfg.tls).toEqual({ cert: 'CERT', key: 'KEY' })
    expect(cfg.socket).toBe('/tmp/docker.sock')
    expect(cfg.images).toEqual(['nodeworks/nivaro', 'registry.corp:5000/team/nivaro-ext'])
    expect(cfg.entrypoints).toEqual(['web', 'websecure'])
    expect(cfg.certResolver).toBe('le')
    // Suffixes always start with a dot, so `evilapps.corp` never matches `apps.corp`.
    expect(cfg.hostSuffixes).toEqual(['.apps.corp', '.other.corp'])
    expect(cfg.redisImage).toBe(`redis@sha256:${DIGEST}`)
    expect(cfg.volumeDriver).toBe('nfs')
    expect(cfg.volumeOpts).toEqual({ type: 'nfs', o: 'addr=10.0.0.5' })
    expect(cfg.extensionsRoot).toBe('/data/ext')
    expect(cfg.extensionsHostRoot).toBe('/srv/ext')
    expect(cfg.extensionsShared).toBe(true)
    expect(cfg.registryAuth).toEqual({ 'registry.corp:5000': 'dTpw' })
  })

  it('publish mode reads the port range and needs no edge network or suffixes', () => {
    const cfg = loadAgentConfig(
      {
        HUB_AGENT_TOKEN_FILE: '/run/secrets/token',
        HUB_AGENT_EDGE: 'publish',
        HUB_AGENT_PUBLISH_PORTS: '3110-3119'
      },
      files(baseFiles)
    )
    expect(cfg.edge).toBe('publish')
    expect(cfg.publishPorts).toEqual([3110, 3119])
    expect(cfg.hostSuffixes).toEqual([])
  })

  it('TOKEN_MISSING: no file setting, unreadable file, or a token under 32 characters', () => {
    expect(
      codeOf(() => loadAgentConfig({ ...traefikEnv, HUB_AGENT_TOKEN_FILE: '' }, files(baseFiles)))
    ).toBe('TOKEN_MISSING')
    expect(
      codeOf(() =>
        loadAgentConfig({ ...traefikEnv, HUB_AGENT_TOKEN_FILE: '/nope' }, files(baseFiles))
      )
    ).toBe('TOKEN_MISSING')
    expect(
      codeOf(() =>
        loadAgentConfig(traefikEnv, files({ '/run/secrets/token': ` ${'x'.repeat(31)} \n` }))
      )
    ).toBe('TOKEN_MISSING')
  })

  it('EDGE_NETWORK_MISSING and HOST_SUFFIXES_MISSING in traefik mode', () => {
    expect(
      codeOf(() => loadAgentConfig({ ...traefikEnv, HUB_AGENT_EDGE_NETWORK: '' }, files(baseFiles)))
    ).toBe('EDGE_NETWORK_MISSING')
    expect(
      codeOf(() =>
        loadAgentConfig({ ...traefikEnv, HUB_AGENT_HOST_SUFFIXES: ' , ' }, files(baseFiles))
      )
    ).toBe('HOST_SUFFIXES_MISSING')
    expect(
      codeOf(() =>
        loadAgentConfig({ ...traefikEnv, HUB_AGENT_HOST_SUFFIXES: 'bad suffix!' }, files(baseFiles))
      )
    ).toBe('HOST_SUFFIXES_MISSING')
  })

  it('PUBLISH_PORTS_BAD in publish mode', () => {
    const env = { HUB_AGENT_TOKEN_FILE: '/run/secrets/token', HUB_AGENT_EDGE: 'publish' }
    for (const v of [undefined, '', '3110', '3119-3110', '80-90', '3110-70000', 'a-b']) {
      expect(
        codeOf(() => loadAgentConfig({ ...env, HUB_AGENT_PUBLISH_PORTS: v }, files(baseFiles))),
        String(v)
      ).toBe('PUBLISH_PORTS_BAD')
    }
  })

  it('REDIS_IMAGE_NOT_PINNED when the redis image has no digest', () => {
    for (const v of ['redis:7-alpine', 'redis', `redis@sha256:${'a'.repeat(63)}`]) {
      expect(
        codeOf(() =>
          loadAgentConfig({ ...traefikEnv, HUB_AGENT_REDIS_IMAGE: v }, files(baseFiles))
        ),
        v
      ).toBe('REDIS_IMAGE_NOT_PINNED')
    }
  })

  it('IMAGES_BAD for a tag, a digest, a wildcard or an empty list', () => {
    for (const v of [
      'nodeworks/nivaro:0.3.208',
      `nodeworks/nivaro@sha256:${DIGEST}`,
      'nodeworks/*',
      ' , ',
      'UPPER/case'
    ]) {
      expect(
        codeOf(() => loadAgentConfig({ ...traefikEnv, HUB_AGENT_IMAGES: v }, files(baseFiles))),
        v
      ).toBe('IMAGES_BAD')
    }
  })

  it('refuses an unknown edge, half a TLS pair, a short HMAC key and unreadable JSON files', () => {
    expect(
      codeOf(() => loadAgentConfig({ ...traefikEnv, HUB_AGENT_EDGE: 'nginx' }, files(baseFiles)))
    ).toBe('EDGE_BAD')
    expect(
      codeOf(() =>
        loadAgentConfig(
          { ...traefikEnv, HUB_AGENT_TLS_CERT_FILE: '/tls/cert.pem' },
          files({ ...baseFiles, '/tls/cert.pem': 'C' })
        )
      )
    ).toBe('TLS_BAD')
    expect(
      codeOf(() =>
        loadAgentConfig(
          { ...traefikEnv, HUB_AGENT_HMAC_KEY_FILE: '/h' },
          files({ ...baseFiles, '/h': 'short' })
        )
      )
    ).toBe('HMAC_KEY_BAD')
    expect(
      codeOf(() =>
        loadAgentConfig(
          { ...traefikEnv, HUB_AGENT_VOLUME_OPTS_FILE: '/v' },
          files({ ...baseFiles, '/v': '{nope' })
        )
      )
    ).toBe('VOLUME_OPTS_BAD')
    expect(
      codeOf(() =>
        loadAgentConfig(
          { ...traefikEnv, HUB_AGENT_VOLUME_OPTS_FILE: '/v' },
          files({ ...baseFiles, '/v': '{"a":1}' })
        )
      )
    ).toBe('VOLUME_OPTS_BAD')
    expect(
      codeOf(() =>
        loadAgentConfig(
          { ...traefikEnv, HUB_AGENT_REGISTRY_AUTH_FILE: '/d' },
          files({ ...baseFiles, '/d': '[]' })
        )
      )
    ).toBe('REGISTRY_AUTH_BAD')
    expect(
      codeOf(() =>
        loadAgentConfig(
          { ...traefikEnv, HUB_AGENT_EXTENSIONS_ROOT: 'relative/path' },
          files(baseFiles)
        )
      )
    ).toBe('EXTENSIONS_ROOT_BAD')
    expect(
      codeOf(() => loadAgentConfig({ ...traefikEnv, HUB_AGENT_LISTEN: 'nope' }, files(baseFiles)))
    ).toBe('LISTEN_BAD')
  })

  it('never puts a value into an error', () => {
    expect.assertions(1)
    const secret = `S3CRET-${'z'.repeat(30)}`
    try {
      loadAgentConfig(
        { ...traefikEnv, HUB_AGENT_HMAC_KEY_FILE: '/h' },
        files({ ...baseFiles, '/h': secret.slice(0, 10) })
      )
    } catch (err) {
      expect(JSON.stringify({ m: (err as Error).message, s: (err as Error).stack })).not.toContain(
        'S3CRET'
      )
    }
  })
})

describe('fix round 1: listen, token strength, volume options, extension root', () => {
  it('INSECURE_LISTEN: a non-loopback listen without TLS', () => {
    for (const listen of ['0.0.0.0:7480', '[::]:7480', '10.0.0.5:7480', 'agent:7480']) {
      expect(
        codeOf(() =>
          loadAgentConfig({ ...traefikEnv, HUB_AGENT_LISTEN: listen }, files(baseFiles))
        ),
        listen
      ).toBe('INSECURE_LISTEN')
    }
  })

  it('loopback listens need no TLS', () => {
    for (const listen of ['127.0.0.1:7480', '127.0.0.2:7480', '[::1]:7480', 'localhost:7480']) {
      expect(
        loadAgentConfig({ ...traefikEnv, HUB_AGENT_LISTEN: listen }, files(baseFiles)).listen
      ).toBe(listen)
    }
  })

  it('HUB_AGENT_INSECURE_HTTP=1 is the escape hatch; any other value is not', () => {
    const env = { ...traefikEnv, HUB_AGENT_LISTEN: '0.0.0.0:7480' }
    expect(loadAgentConfig({ ...env, HUB_AGENT_INSECURE_HTTP: '1' }, files(baseFiles)).listen).toBe(
      '0.0.0.0:7480'
    )
    for (const v of ['true', 'on', 'yes', '0', '']) {
      expect(
        codeOf(() => loadAgentConfig({ ...env, HUB_AGENT_INSECURE_HTTP: v }, files(baseFiles))),
        v
      ).toBe('INSECURE_LISTEN')
    }
  })

  it('TLS allows a non-loopback listen', () => {
    const cfg = loadAgentConfig(
      {
        ...traefikEnv,
        HUB_AGENT_LISTEN: '0.0.0.0:7480',
        HUB_AGENT_TLS_CERT_FILE: '/c',
        HUB_AGENT_TLS_KEY_FILE: '/k'
      },
      files({ ...baseFiles, '/c': 'CERT', '/k': 'KEY' })
    )
    expect(cfg.tls).toEqual({ cert: 'CERT', key: 'KEY' })
  })

  it('TOKEN_WEAK: a long token with fewer than 8 distinct characters', () => {
    expect(
      codeOf(() =>
        loadAgentConfig(traefikEnv, files({ '/run/secrets/token': 'abcdefg'.repeat(10) }))
      )
    ).toBe('TOKEN_WEAK')
    expect(
      codeOf(() => loadAgentConfig(traefikEnv, files({ '/run/secrets/token': 't'.repeat(64) })))
    ).toBe('TOKEN_WEAK')
    expect(
      loadAgentConfig(traefikEnv, files({ '/run/secrets/token': 'abcdefgh'.repeat(4) })).token
    ).toBe('abcdefgh'.repeat(4))
  })

  it('HMAC_KEY_BAD for a weak HMAC key', () => {
    expect(
      codeOf(() =>
        loadAgentConfig(
          { ...traefikEnv, HUB_AGENT_HMAC_KEY_FILE: '/h' },
          files({ ...baseFiles, '/h': 'h'.repeat(40) })
        )
      )
    ).toBe('HMAC_KEY_BAD')
  })

  it('VOLUME_OPTS_BAD for driver options that bind a host path', () => {
    for (const opts of [
      '{"type":"none","o":"bind","device":"/"}',
      '{"o":"bind"}',
      '{"o":"rw, rbind"}',
      '{"o":"BIND"}',
      '{"device":"/srv/data"}',
      '{"type":"none","device":":/export","o":"addr=10.0.0.5"}',
      '{"type":"none","o":"addr=10.0.0.5"}',
      '{"type":"nfs","o":"addr=10.0.0.5","device":"/var/run"}',
      '{"type":"nfs","o":"addr=x,bind","device":":/export"}',
      '{"type":"nfs","o":"addr=x,remount","device":":/export"}',
      '{"type":"nfs","o":"rw","device":":/export"}',
      '{"type":"nfs","o":"addr=","device":":/export"}',
      '{"type":"nfs","o":"addr=x","device":":/export/../../etc"}',
      '{"type":"ext4","o":"addr=x","device":":/export"}',
      '{"type":"nfs","device":":/export"}'
    ]) {
      expect(
        codeOf(() =>
          loadAgentConfig(
            { ...traefikEnv, HUB_AGENT_VOLUME_OPTS_FILE: '/v' },
            files({ ...baseFiles, '/v': opts })
          )
        ),
        opts
      ).toBe('VOLUME_OPTS_BAD')
    }
  })

  it('accepts an NFS export (ruling P4-12)', () => {
    for (const opts of [
      { type: 'nfs', o: 'addr=10.0.0.5,rw,nfsvers=4', device: ':/export/uploads' },
      { type: 'nfs4', o: 'addr=nas.corp', device: ':/' },
      { type: 'nfs', o: 'addr=10.0.0.5' }
    ]) {
      const cfg = loadAgentConfig(
        { ...traefikEnv, HUB_AGENT_VOLUME_OPTS_FILE: '/v' },
        files({ ...baseFiles, '/v': JSON.stringify(opts) })
      )
      expect(cfg.volumeOpts).toEqual(opts)
    }
  })

  it('EXTENSIONS_ROOT_BAD for /, a single segment, . or ..', () => {
    for (const root of ['/', '/srv', '//srv', '/srv/./x', '/srv/../etc']) {
      expect(
        codeOf(() =>
          loadAgentConfig({ ...traefikEnv, HUB_AGENT_EXTENSIONS_HOST_ROOT: root }, files(baseFiles))
        ),
        root
      ).toBe('EXTENSIONS_ROOT_BAD')
      expect(
        codeOf(() =>
          loadAgentConfig({ ...traefikEnv, HUB_AGENT_EXTENSIONS_ROOT: root }, files(baseFiles))
        ),
        root
      ).toBe('EXTENSIONS_ROOT_BAD')
    }
  })
})

describe('parseListen', () => {
  it('splits host and port, including IPv6', () => {
    expect(parseListen('0.0.0.0:7480')).toEqual({ host: '0.0.0.0', port: 7480 })
    expect(parseListen('[::]:7480')).toEqual({ host: '::', port: 7480 })
  })
})
