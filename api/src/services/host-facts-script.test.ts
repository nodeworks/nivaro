import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// The host facts collector (#2829 #2831 #2836 #2837) is a shell script that runs on the Docker
// host; these tests run it in fixture mode (fake /proc, /etc/fstab, /boot and command output).
const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/host-facts/nivaro-host-facts.sh'
)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function put(root: string, rel: string, body: string) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

function fixture(): { root: string; out: string; state: string } {
  const base = mkdtempSync(join(tmpdir(), 'nhf-'))
  dirs.push(base)
  const root = join(base, 'fx')
  const out = join(base, 'textfile')
  const state = join(base, 'state')
  mkdirSync(root)
  return { root, out, state }
}

function fullFixture(root: string) {
  put(root, 'cmd/uname', '4.18.0-477.el8.x86_64\n')
  put(root, 'boot/vmlinuz-4.18.0-477.el8.x86_64', '')
  put(root, 'boot/vmlinuz-4.18.0-513.el8.x86_64', '')
  put(root, 'boot/vmlinuz-0-rescue-0123456789', '')
  put(root, 'proc/stat', 'cpu  1 2 3 4\nbtime 1760000000\nprocesses 99\n')
  put(
    root,
    'cmd/df_boot',
    'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1038336 950000 88336 92% /boot\n'
  )
  put(root, 'proc/1/stat', '1 (systemd) S 0 1 1 0\n')
  put(root, 'proc/200/stat', '200 (odd (name)) D 2 0 0 0\n')
  put(root, 'proc/201/stat', '201 (cat) D 1 201 201 0\n')
  put(root, 'proc/uptime', '10000.00 50000.00\n')
  put(
    root,
    'cmd/dmesg',
    [
      '[  100.000000] nfs: server nas02 not responding, still trying',
      '[  200.000000] nfs: server nas02 OK',
      '[ 8000.000000] INFO: task old:12 blocked for more than 120 seconds.',
      '[ 9000.500000] nfs: server nas01 not responding, still trying',
      '[ 9500.123000] INFO: task cat:201 blocked for more than 120 seconds.',
      '[ 9600.000000] INFO: task cp:202 blocked for more than 120 seconds.'
    ].join('\n')
  )
  put(
    root,
    'proc/mounts',
    'nas01:/export /mnt/data nfs4 rw 0 0\nnas02:/x /mnt/b nfs rw 0 0\n/dev/sda2 / xfs rw 0 0\n'
  )
  put(
    root,
    'etc/fstab',
    [
      '# remote shares',
      'nas01:/export /mnt/data nfs4 defaults 0 0',
      'nas02:/x /mnt/b nfs defaults,nofail 0 0',
      '//files/share /mnt/c cifs credentials=/root/.c,_netdev 0 0',
      '/dev/sda2 / xfs defaults 0 0'
    ].join('\n')
  )
  put(
    root,
    'cmd/systemctl_docker',
    'RequiresMountsFor=/var/lib/docker /mnt/b/sub\nAfter=network-online.target containerd.service\n'
  )
  put(root, 'cmd/docker_ps', 'abc\ndef\n')
  put(
    root,
    'cmd/docker_inspect',
    '/web /var/lib/docker/containers/abc/abc-json.log\n/db /var/lib/docker/containers/def/def-json.log\n/gone /var/lib/docker/containers/zzz/missing.log\n'
  )
  put(root, 'var/lib/docker/containers/abc/abc-json.log', 'x'.repeat(1234))
  put(root, 'var/lib/docker/containers/def/def-json.log', 'y'.repeat(10))
  put(root, 'cmd/openssl_enddate', 'notAfter=Jan  1 00:00:00 2027 GMT\n')
  put(
    root,
    'cmd/dnf_security',
    'RHSA-2026:1 Important/Sec. kernel-4.18\nRHSA-2026:2 Moderate/Sec. openssl-1.1\nRHSA-2026:3 Low/Sec. curl-7\n'
  )
  put(root, 'cmd/needs_restarting', 'Reboot is required\n')
  put(root, 'cmd/needs_restarting.exit', '1')
  put(root, 'var/lib/docker/volumes/pgdata/_data/base/file', 'data')
  utimesSync(join(root, 'var/lib/docker/volumes/pgdata/_data/base/file'), 1761000000, 1761000000)
  utimesSync(join(root, 'var/lib/docker/volumes/pgdata/_data/base'), 1760000000, 1760000000)
  utimesSync(join(root, 'var/lib/docker/volumes/pgdata/_data'), 1760000000, 1760000000)
}

function run(
  f: { root: string; out: string; state: string },
  env: Record<string, string> = {}
): string {
  execFileSync('bash', [SCRIPT], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOST_FACTS_FIXTURE_DIR: f.root,
      TEXTFILE_DIR: f.out,
      HOST_FACTS_STATE_DIR: f.state,
      HOST_FACTS_NOW: '1761100000',
      NIVARO_HOST_NAME: 'staging',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return readFileSync(join(f.out, 'nivaro_host.prom'), 'utf8')
}

/** name{labels} value lines → [{name, labels, value}] */
function samples(text: string) {
  return text
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = /^([a-z_]+)\{(.*)\} (\S+)$/.exec(l)
      if (!m) throw new Error(`bad line: ${l}`)
      const labels: Record<string, string> = {}
      for (const [, k, v] of m[2].matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)) labels[k] = v
      return { name: m[1], labels, value: Number(m[3]) }
    })
}

const one = (s: ReturnType<typeof samples>, name: string, where: Record<string, string> = {}) =>
  s.filter((x) => x.name === name && Object.entries(where).every(([k, v]) => x.labels[k] === v))

describe('nivaro-host-facts.sh', () => {
  it('parses (bash -n)', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow()
  })

  it('never uses a predictable temp path (it runs as root)', () => {
    const code = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/\/tmp\b/)
    expect(code).not.toMatch(/TMPDIR/)
    expect(code).not.toMatch(/\$\$/)
    // Older bash writes heredocs to a file under TMPDIR.
    expect(code).not.toMatch(/<<-?\s*['"]?[A-Z]/)
    expect(code).toMatch(/mktemp "\$TEXTFILE_DIR\/\.nivaro_host\.prom\.XXXXXX"/)
  })

  it('compose example: no extra capability, narrow read-only mounts, no Docker socket', () => {
    const compose = readFileSync(join(dirname(SCRIPT), 'compose.example.yml'), 'utf8')
    const live = compose
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .map((l) => l.replace(/\s+#.*$/, ''))
      .join('\n')
    expect(live).not.toMatch(/cap_add/)
    expect(live).not.toMatch(/DAC_READ_SEARCH|SYS_ADMIN|privileged/)
    expect(live).not.toMatch(/-\s*\/:\/host/)
    expect(live).not.toMatch(/source:\s*\/\s*$/m)
    expect(live).not.toMatch(/docker\.sock/)
    expect(live).not.toMatch(/pid:\s*host/)
    expect(live).toMatch(/cap_drop: \[ALL\]/)
    expect(live).toMatch(/read_only: true/)
    expect(live).toMatch(/no-new-privileges:true/)
    // Every host bind mount is read-only and lands under /host.
    for (const m of live.matchAll(/^\s*- (\/[^:\s]+):([^:\s]+)(?::(\S+))?\s*$/gm)) {
      expect(m[2].startsWith('/host/')).toBe(true)
      expect(m[3]).toBe('ro')
    }
    // The swarm certificates folder also holds the node's private key: never mounted.
    expect(live).not.toMatch(/swarm\/certificates/)
  })

  it('keeps its state dir private and leaves no temp files behind', () => {
    const f = fixture()
    fullFixture(f.root)
    run(f)
    expect(statSync(f.state).mode & 0o777).toBe(0o700)
    expect(readdirSync(f.out)).toEqual(['nivaro_host.prom'])
    expect(readdirSync(f.state).sort()).toEqual(['heavy.prom', 'heavy.stamp'])
    expect(statSync(join(f.out, 'nivaro_host.prom')).mode & 0o777).toBe(0o644)
  })

  it('refuses a state dir that is a symlink', () => {
    const f = fixture()
    const victim = join(dirname(f.state), 'victim')
    mkdirSync(victim)
    writeFileSync(join(victim, 'heavy.prom'), 'keep')
    symlinkSync(victim, f.state)
    expect(() => run(f)).toThrow()
    expect(readFileSync(join(victim, 'heavy.prom'), 'utf8')).toBe('keep')
    expect(existsSync(join(f.out, 'nivaro_host.prom'))).toBe(false)
  })

  it('writes every host fact in node_exporter text format', () => {
    const f = fixture()
    fullFixture(f.root)
    const text = run(f)
    const s = samples(text)

    // Format: HELP + TYPE once per metric name, every sample carries host="staging".
    const names = [...new Set(s.map((x) => x.name))]
    for (const n of names) {
      expect(text.split('\n').filter((l) => l.startsWith(`# HELP ${n} `))).toHaveLength(1)
      expect(text).toContain(`# TYPE ${n} gauge`)
      expect(n.startsWith('nivaro_host_')).toBe(true)
    }
    expect(s.every((x) => x.labels.host === 'staging')).toBe(true)
    expect(s.every((x) => Number.isFinite(x.value))).toBe(true)

    const v = (name: string, where: Record<string, string> = {}) => one(s, name, where)[0]?.value
    expect(one(s, 'nivaro_host_kernel_running_info')[0].labels.version).toBe(
      '4.18.0-477.el8.x86_64'
    )
    expect(one(s, 'nivaro_host_kernel_installed_info')[0].labels.version).toBe(
      '4.18.0-513.el8.x86_64'
    )
    expect(v('nivaro_host_boot_time_seconds')).toBe(1760000000)
    expect(v('nivaro_host_boot_free_bytes')).toBe(88336 * 1024)
    expect(v('nivaro_host_dstate_processes')).toBe(2)
    // Only messages inside the last 15 minutes of uptime (10000 s) count.
    expect(v('nivaro_host_hung_task_events')).toBe(2)
    expect(v('nivaro_host_nfs_not_responding', { server: 'nas01' })).toBe(1)
    expect(v('nivaro_host_nfs_not_responding', { server: 'nas02' })).toBe(0)
    expect(v('nivaro_host_mount_nofail', { mountpoint: '/mnt/data', fstype: 'nfs4' })).toBe(0)
    expect(v('nivaro_host_mount_nofail', { mountpoint: '/mnt/b', fstype: 'nfs' })).toBe(1)
    expect(v('nivaro_host_mount_nofail', { mountpoint: '/mnt/c', fstype: 'cifs' })).toBe(1)
    expect(one(s, 'nivaro_host_mount_nofail', { mountpoint: '/' })).toHaveLength(0)
    expect(v('nivaro_host_docker_waits_for_mounts', { mountpoint: '/mnt/data' })).toBe(0)
    expect(v('nivaro_host_docker_waits_for_mounts', { mountpoint: '/mnt/b' })).toBe(1)
    expect(v('nivaro_host_container_log_bytes', { container: 'web' })).toBe(1234)
    expect(v('nivaro_host_container_log_bytes', { container: 'db' })).toBe(10)
    expect(one(s, 'nivaro_host_container_log_bytes', { container: 'gone' })).toHaveLength(0)
    expect(v('nivaro_host_swarm_node_cert_expiry_seconds')).toBe(1798761600)
    expect(v('nivaro_host_security_updates')).toBe(3)
    expect(v('nivaro_host_reboot_required')).toBe(1)
    expect(v('nivaro_host_volume_last_write_seconds', { volume: 'pgdata' })).toBe(1761000000)
    expect(v('nivaro_host_facts_last_run_seconds')).toBe(1761100000)
  })

  it('fails soft: with nothing to read it writes only the last-run stamp', () => {
    const f = fixture()
    const s = samples(run(f))
    expect(s.map((x) => x.name)).toEqual(['nivaro_host_facts_last_run_seconds'])
  })

  it('escapes label values', () => {
    const f = fixture()
    put(f.root, 'cmd/uname', '5.14 "custom"\\x\n')
    const text = run(f, { NIVARO_HOST_NAME: 'a"b' })
    expect(text).toContain(
      'nivaro_host_kernel_running_info{host="a\\"b",version="5.14 \\"custom\\"\\\\x"} 1'
    )
  })

  it('caches the slow probes for HOST_FACTS_HEAVY_SECONDS', () => {
    const f = fixture()
    put(f.root, 'cmd/dnf_security', 'A Important/Sec. a\n')
    const first = samples(run(f, { HOST_FACTS_NOW: '1000000' }))
    expect(one(first, 'nivaro_host_security_updates')[0].value).toBe(1)

    put(f.root, 'cmd/dnf_security', 'A Important/Sec. a\nB Important/Sec. b\n')
    const cached = samples(run(f, { HOST_FACTS_NOW: '1000060' }))
    expect(one(cached, 'nivaro_host_security_updates')[0].value).toBe(1)
    expect(one(cached, 'nivaro_host_facts_last_run_seconds')[0].value).toBe(1000060)

    const fresh = samples(run(f, { HOST_FACTS_NOW: '1001800' }))
    expect(one(fresh, 'nivaro_host_security_updates')[0].value).toBe(2)
  })

  it('container mode (HOST_ROOT) reads the host from its files, not from the container', () => {
    const f = fixture()
    const r = f.root
    put(r, 'etc/hostname', 'stg-docker-01.example.com\n')
    put(r, 'cmd/uname', '6.1.0-25-amd64\n')
    put(r, 'boot/vmlinuz-6.1.0-26-amd64', '')
    put(r, 'proc/stat', 'btime 1760000000\n')
    put(r, 'proc/uptime', '10000.00 1.00\n')
    put(r, 'proc/7/stat', '7 (cp) D 1 0 0 0\n')
    // The container's own mount table has no NFS; the host's (pid 1) has.
    put(r, 'proc/mounts', 'overlay / overlay rw 0 0\n')
    put(r, 'proc/1/mounts', 'nas01:/export /mnt/data nfs4 rw 0 0\n')
    put(
      r,
      'etc/fstab',
      'nas01:/export /mnt/data nfs4 defaults 0 0\nnas02:/b /mnt/b nfs nofail 0 0\n'
    )
    // Kernel messages come from the host journal; dmesg (needs CAP_SYSLOG) is never called.
    put(r, 'var/log/journal/.keep', '')
    put(
      r,
      'cmd/journal_kernel',
      '[ 9500.123456] stg kernel: INFO: task cp:7 blocked for more than 120 seconds.\n[ 9600.000000] stg kernel: nfs: server nas01 not responding, still trying\n'
    )
    put(r, 'cmd/dmesg', '[ 9900.0] INFO: task a blocked for more than 120 seconds.\n'.repeat(5))
    // docker.service comes from its unit file + drop-ins, never systemctl.
    put(
      r,
      'usr/lib/systemd/system/docker.service',
      '[Unit]\nDescription=Docker\nAfter=network-online.target containerd.service\nRequiresMountsFor=/var/lib/docker\n\n[Service]\nRequiresMountsFor=/mnt/data\n'
    )
    put(
      r,
      'etc/systemd/system/docker.service.d/10-mounts.conf',
      '[Unit]\nRequiresMountsFor=\nRequiresMountsFor=/mnt/b/sub\n'
    )
    put(r, 'cmd/systemctl_docker', 'RequiresMountsFor=/mnt/data\nAfter=remote-fs.target\n')
    // Packages: apt against the host's lists; dnf and needs-restarting are host-only.
    put(r, 'var/lib/dpkg/status', 'Package: libc6\n')
    put(
      r,
      'cmd/apt_upgrade',
      'Inst libssl3 [3.0.13-1] (3.0.15-1 Debian-Security:12/stable-security [amd64])\nInst curl [7.88] (7.88.2 Debian-Security:12/stable-security [amd64])\nInst vim [9.0] (9.0.1 Debian:12.7/stable [amd64])\n'
    )
    put(r, 'cmd/dnf_security', 'A Important/Sec. a\n'.repeat(9))
    put(r, 'cmd/needs_restarting', '')
    put(r, 'cmd/needs_restarting.exit', '0')

    const s = samples(run(f, { HOST_ROOT: r, NIVARO_HOST_NAME: '' }))
    const v = (name: string, where: Record<string, string> = {}) => one(s, name, where)[0]?.value
    expect(s.every((x) => x.labels.host === 'stg-docker-01')).toBe(true)
    expect(v('nivaro_host_dstate_processes')).toBe(1)
    expect(v('nivaro_host_hung_task_events')).toBe(1)
    expect(v('nivaro_host_nfs_not_responding', { server: 'nas01' })).toBe(1)
    // The drop-in reset the list, then named /mnt/b/sub; [Service] lines do not count.
    expect(v('nivaro_host_docker_waits_for_mounts', { mountpoint: '/mnt/b' })).toBe(1)
    expect(v('nivaro_host_docker_waits_for_mounts', { mountpoint: '/mnt/data' })).toBe(0)
    expect(v('nivaro_host_security_updates')).toBe(2)
    // Running 6.1.0-25, /boot has 6.1.0-26: reboot needed (needs-restarting is not consulted).
    expect(v('nivaro_host_reboot_required')).toBe(1)
  })

  it('container mode leaves out what it cannot read from the host files', () => {
    const f = fixture()
    put(f.root, 'cmd/dmesg', '[ 1.0] INFO: task a blocked for more than 120 seconds.\n')
    put(f.root, 'proc/uptime', '100.00 1.00\n')
    put(f.root, 'cmd/dnf_security', 'A Important/Sec. a\n')
    put(f.root, 'cmd/systemctl_docker', 'RequiresMountsFor=/mnt/data\n')
    put(f.root, 'etc/fstab', 'nas01:/export /mnt/data nfs4 defaults 0 0\n')
    const s = samples(run(f, { HOST_ROOT: f.root }))
    expect(one(s, 'nivaro_host_hung_task_events')).toHaveLength(0)
    expect(one(s, 'nivaro_host_security_updates')).toHaveLength(0)
    expect(one(s, 'nivaro_host_docker_waits_for_mounts')).toHaveLength(0)
    expect(one(s, 'nivaro_host_mount_nofail')).toHaveLength(1)
  })

  it('leaves security updates out when the package tool fails', () => {
    const f = fixture()
    put(f.root, 'cmd/dnf_security', 'Error: Failed to download metadata\n')
    put(f.root, 'cmd/dnf_security.exit', '1')
    expect(one(samples(run(f)), 'nivaro_host_security_updates')).toHaveLength(0)
  })

  it('falls back to running vs installed kernel when no reboot tool answers', () => {
    const f = fixture()
    put(f.root, 'cmd/uname', '6.1.0-25-amd64\n')
    put(f.root, 'boot/vmlinuz-6.1.0-25-amd64', '')
    expect(one(samples(run(f)), 'nivaro_host_reboot_required')[0].value).toBe(0)
    const g = fixture()
    put(g.root, 'cmd/uname', '6.1.0-25-amd64\n')
    put(g.root, 'boot/vmlinuz-6.1.0-26-amd64', '')
    expect(one(samples(run(g)), 'nivaro_host_reboot_required')[0].value).toBe(1)
    const d = fixture()
    put(d.root, 'run/reboot-required', '')
    expect(one(samples(run(d)), 'nivaro_host_reboot_required')[0].value).toBe(1)
  })
})
