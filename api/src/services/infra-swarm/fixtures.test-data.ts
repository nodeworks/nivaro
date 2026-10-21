/**
 * Engine API fixtures for the infra-swarm tests, shaped like real Docker 27 answers (trimmed to
 * the fields that matter, extra noise kept where a derivation must ignore it).
 */
import type {
  EngineContainerInspect,
  EngineContainerSummary,
  EngineInfo,
  EngineNode,
  EngineSecret,
  EngineService,
  EngineTask
} from './engine.js'

const D_OLD = 'sha256:1111111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const D_NEW = 'sha256:2222222222222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
export const IMG_OLD = `nodeworks/nivaro:0.2.78@${D_OLD}`
export const IMG_NEW = `nodeworks/nivaro:0.2.79@${D_NEW}`

export const managerInfo: EngineInfo = {
  Name: 'stage-mgr-1',
  Swarm: {
    NodeID: 'node1aaaaaaaaaaaaaaaaaaaaa',
    NodeAddr: '10.0.0.11',
    LocalNodeState: 'active',
    ControlAvailable: true,
    Error: '',
    Nodes: 3,
    Managers: 3,
    Cluster: {
      ID: 'clusterxxxxxxxxxxxxxxxxx',
      Version: { Index: 12 },
      CreatedAt: '2026-09-01T10:00:00.000000000Z',
      UpdatedAt: '2026-10-21T08:00:00.000000000Z',
      Spec: {
        Name: 'default',
        Orchestration: { TaskHistoryRetentionLimit: 5 },
        Raft: {
          SnapshotInterval: 10000,
          KeepOldSnapshots: 0,
          LogEntriesForSlowFollowers: 500,
          ElectionTick: 10,
          HeartbeatTick: 1
        },
        Dispatcher: { HeartbeatPeriod: 5_000_000_000 },
        CAConfig: { NodeCertExpiry: 7_776_000_000_000_000 },
        EncryptionConfig: { AutoLockManagers: false }
      },
      RootRotationInProgress: false,
      DataPathPort: 4789,
      DefaultAddrPool: ['10.0.0.0/8'],
      SubnetSize: 24
    }
  }
}

export const workerInfo: EngineInfo = {
  Name: 'stage-wrk-1',
  Swarm: { NodeID: 'node3', LocalNodeState: 'active', ControlAvailable: false }
}

export const plainInfo: EngineInfo = { Name: 'build-box', Swarm: { LocalNodeState: 'inactive' } }

export const nodes: EngineNode[] = [
  {
    ID: 'node1aaaaaaaaaaaaaaaaaaaaa',
    Spec: { Role: 'manager', Availability: 'active', Labels: { zone: 'a' } },
    Description: {
      Hostname: 'stage-mgr-1',
      Platform: { Architecture: 'x86_64', OS: 'linux' },
      Resources: { NanoCPUs: 8_000_000_000, MemoryBytes: 33_000_000_000 },
      Engine: { EngineVersion: '27.3.1', Labels: { disk: 'ssd' } }
    },
    Status: { State: 'ready', Addr: '10.0.0.11' },
    ManagerStatus: { Leader: true, Reachability: 'reachable', Addr: '10.0.0.11:2377' }
  },
  {
    ID: 'node2bbbbbbbbbbbbbbbbbbbbb',
    Spec: { Role: 'manager', Availability: 'active', Labels: {} },
    Description: { Hostname: 'stage-mgr-2', Engine: { EngineVersion: '27.3.1' } },
    Status: { State: 'ready', Addr: '10.0.0.12' },
    ManagerStatus: { Reachability: 'unreachable', Addr: '10.0.0.12:2377' }
  },
  {
    ID: 'node3ccccccccccccccccccccc',
    Spec: { Role: 'worker', Availability: 'drain', Labels: {} },
    Description: { Hostname: 'stage-wrk-1', Engine: { EngineVersion: '26.1.4' } },
    Status: { State: 'down', Message: 'heartbeat failure', Addr: '10.0.0.13' }
  }
]

/** `app` is mid-update (start-first, rollback on failure); `api` is broken; `redis` global. */
export const services: EngineService[] = [
  {
    ID: 'svcapp',
    Version: { Index: 900 },
    CreatedAt: '2026-10-01T10:00:00Z',
    UpdatedAt: '2026-10-21T20:00:00Z',
    Spec: {
      Name: 'nivaro_app',
      Labels: { 'com.docker.stack.namespace': 'nivaro', 'com.docker.stack.image': IMG_NEW },
      TaskTemplate: {
        ContainerSpec: {
          Image: IMG_NEW,
          Secrets: [
            {
              SecretID: 'sec-db-v2',
              SecretName: 'nivaro_db_password_v2',
              File: { Name: 'db_password' }
            }
          ],
          Configs: [
            {
              ConfigID: 'cfg-traefik-v1',
              ConfigName: 'traefik_yml_v1',
              File: { Name: '/etc/traefik.yml' }
            }
          ]
        },
        ForceUpdate: 0
      },
      Mode: { Replicated: { Replicas: 2 } },
      UpdateConfig: {
        Parallelism: 1,
        Delay: 10_000_000_000,
        FailureAction: 'rollback',
        Monitor: 30_000_000_000,
        MaxFailureRatio: 0,
        Order: 'start-first'
      },
      RollbackConfig: { Parallelism: 1, FailureAction: 'pause', Order: 'stop-first' }
    },
    Endpoint: {
      Ports: [{ Protocol: 'tcp', TargetPort: 3055, PublishedPort: 8080, PublishMode: 'ingress' }]
    },
    UpdateStatus: {
      State: 'updating',
      StartedAt: '2026-10-21T20:00:00Z',
      Message: 'update in progress'
    },
    ServiceStatus: { RunningTasks: 2, DesiredTasks: 2 }
  },
  {
    ID: 'svcapi',
    CreatedAt: '2026-10-01T10:00:00Z',
    UpdatedAt: '2026-10-20T10:00:00Z',
    Spec: {
      Name: 'nivaro_worker',
      Labels: { 'com.docker.stack.namespace': 'nivaro' },
      TaskTemplate: {
        ContainerSpec: {
          Image: IMG_OLD,
          Secrets: [{ SecretID: 'sec-db-v1', SecretName: 'nivaro_db_password_v1' }],
          Configs: [{ ConfigID: 'cfg-traefik-v2', ConfigName: 'traefik_yml_v2' }]
        }
      },
      Mode: { Replicated: { Replicas: 1 } }
    },
    ServiceStatus: { RunningTasks: 0, DesiredTasks: 1 }
  },
  {
    ID: 'svcredis',
    CreatedAt: '2026-10-01T10:00:00Z',
    Spec: {
      Name: 'redis',
      TaskTemplate: { ContainerSpec: { Image: 'redis:7.4@sha256:abcdef0123456789' } },
      Mode: { Global: {} }
    }
  }
]

export const tasks: EngineTask[] = [
  // app slot 1: old shut down at 20:00:40, new running since 20:00:30.
  {
    ID: 'tapp1old',
    ServiceID: 'svcapp',
    Slot: 1,
    NodeID: 'node1aaaaaaaaaaaaaaaaaaaaa',
    CreatedAt: '2026-10-20T09:00:00Z',
    Spec: { ContainerSpec: { Image: IMG_OLD } },
    Status: { Timestamp: '2026-10-21T20:00:40Z', State: 'shutdown', Message: 'shutdown' },
    DesiredState: 'shutdown'
  },
  {
    ID: 'tapp1new',
    ServiceID: 'svcapp',
    Slot: 1,
    NodeID: 'node1aaaaaaaaaaaaaaaaaaaaa',
    CreatedAt: '2026-10-21T20:00:00Z',
    Spec: { ContainerSpec: { Image: IMG_NEW } },
    Status: {
      Timestamp: '2026-10-21T20:00:30Z',
      State: 'running',
      Message: 'started',
      ContainerStatus: { ContainerID: 'c0ffee000001aaaaaaaaaaaaaaaaaaaaaaaaaaaa', PID: 4242 }
    },
    DesiredState: 'running'
  },
  // app slot 2: still on the old image (parallelism 1); one failed task in history.
  {
    ID: 'tapp2fail',
    ServiceID: 'svcapp',
    Slot: 2,
    NodeID: 'node2bbbbbbbbbbbbbbbbbbbbb',
    CreatedAt: '2026-10-20T08:00:00Z',
    Spec: { ContainerSpec: { Image: IMG_OLD } },
    Status: {
      Timestamp: '2026-10-20T08:01:00Z',
      State: 'failed',
      Message: 'task: non-zero exit (137)',
      Err: 'task: non-zero exit (137)',
      ContainerStatus: { ExitCode: 137 }
    },
    DesiredState: 'shutdown'
  },
  {
    ID: 'tapp2old',
    ServiceID: 'svcapp',
    Slot: 2,
    NodeID: 'node2bbbbbbbbbbbbbbbbbbbbb',
    CreatedAt: '2026-10-20T08:02:00Z',
    Spec: { ContainerSpec: { Image: IMG_OLD } },
    Status: { Timestamp: '2026-10-20T08:02:20Z', State: 'running', Message: 'started' },
    DesiredState: 'running'
  },
  // worker: cannot schedule.
  {
    ID: 'tworker1',
    ServiceID: 'svcapi',
    Slot: 1,
    CreatedAt: '2026-10-21T19:00:00Z',
    Spec: { ContainerSpec: { Image: IMG_OLD } },
    Status: {
      Timestamp: '2026-10-21T19:00:01Z',
      State: 'pending',
      Message: 'pending task scheduling',
      Err: 'no suitable node (scheduling constraints not satisfied on 3 nodes)'
    },
    DesiredState: 'running'
  },
  {
    ID: 'tworker0',
    ServiceID: 'svcapi',
    Slot: 1,
    NodeID: 'node3ccccccccccccccccccccc',
    CreatedAt: '2026-10-21T18:00:00Z',
    Spec: { ContainerSpec: { Image: IMG_OLD } },
    Status: {
      Timestamp: '2026-10-21T18:59:00Z',
      State: 'rejected',
      Message: 'preparing',
      Err: 'No such container: nivaro_worker.1.tworker0'
    },
    DesiredState: 'shutdown'
  },
  // redis: global, one per node (Slot 0).
  {
    ID: 'tredis1',
    ServiceID: 'svcredis',
    NodeID: 'node1aaaaaaaaaaaaaaaaaaaaa',
    CreatedAt: '2026-10-01T10:00:00Z',
    Spec: { ContainerSpec: { Image: 'redis:7.4@sha256:abcdef0123456789' } },
    Status: { Timestamp: '2026-10-01T10:00:05Z', State: 'running' },
    DesiredState: 'running'
  },
  {
    ID: 'tredis2',
    ServiceID: 'svcredis',
    NodeID: 'node2bbbbbbbbbbbbbbbbbbbbb',
    CreatedAt: '2026-10-01T10:00:00Z',
    Spec: { ContainerSpec: { Image: 'redis:7.4@sha256:abcdef0123456789' } },
    Status: { Timestamp: '2026-10-01T10:00:06Z', State: 'running' },
    DesiredState: 'running'
  }
]

export const containers: EngineContainerSummary[] = [
  {
    Id: 'c0ffee000001aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    Names: ['/nivaro_app.1.tapp1new'],
    Image: IMG_NEW,
    Created: 1792699200,
    Labels: {
      'com.docker.stack.namespace': 'nivaro',
      'com.docker.swarm.service.name': 'nivaro_app',
      'org.opencontainers.image.version': '0.2.79'
    },
    State: 'running',
    Status: 'Up 2 minutes (healthy)'
  },
  {
    Id: 'beef00000002bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    Names: ['/grafana-grafana-1'],
    Image: 'grafana/grafana:11.2.0',
    Created: 1792600000,
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' },
      { IP: '::', PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' }
    ],
    Labels: {
      'com.docker.compose.project': 'grafana',
      'com.docker.compose.service': 'grafana',
      'org.opencontainers.image.version': '11.2.0'
    },
    State: 'running',
    Status: 'Up 3 hours (unhealthy)'
  },
  {
    Id: 'dead00000003cccccccccccccccccccccccccccc',
    Names: ['/grafana-renderer-1'],
    Image: 'grafana/grafana-image-renderer:3.11.0',
    Created: 1792600000,
    Labels: { 'com.docker.compose.project': 'grafana', 'com.docker.compose.service': 'renderer' },
    State: 'exited',
    Status: 'Exited (1) 5 minutes ago'
  },
  {
    Id: 'aaaa00000004dddddddddddddddddddddddddddd',
    Names: ['/grafana-migrate-1'],
    Image: 'grafana/grafana:11.2.0',
    Labels: { 'com.docker.compose.project': 'grafana', 'com.docker.compose.service': 'migrate' },
    State: 'exited',
    Status: 'Exited (0) 3 hours ago'
  },
  {
    Id: 'bbbb00000005eeeeeeeeeeeeeeeeeeeeeeeeeeee',
    Names: ['/scratch'],
    Image: 'alpine:3.20',
    Labels: {},
    State: 'running',
    Status: 'Up 1 day'
  }
]

export const inspectHealthy: EngineContainerInspect = {
  Id: 'c0ffee000001aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  Name: '/nivaro_app.1.tapp1new',
  RestartCount: 0,
  State: {
    Status: 'running',
    Running: true,
    StartedAt: '2026-10-21T20:00:29.500000000Z',
    FinishedAt: '0001-01-01T00:00:00Z',
    Health: {
      Status: 'healthy',
      FailingStreak: 0,
      Log: [
        {
          Start: '2026-10-21T20:00:35.000Z',
          End: '2026-10-21T20:00:35.200Z',
          ExitCode: 1,
          Output: 'curl: (7) Failed to connect to localhost port 3055'
        },
        {
          Start: '2026-10-21T20:00:45.000Z',
          End: '2026-10-21T20:00:45.100Z',
          ExitCode: 0,
          Output: '{"status":"ok"}'
        }
      ]
    }
  },
  Config: {
    Image: IMG_NEW,
    Labels: { 'org.opencontainers.image.version': '0.2.79', secret_looking: 'not-returned' }
  }
}

export const secrets: EngineSecret[] = [
  {
    ID: 'sec-db-v1',
    CreatedAt: '2026-09-01T10:00:00Z',
    UpdatedAt: '2026-09-01T10:00:00Z',
    Spec: { Name: 'nivaro_db_password_v1', Labels: { 'com.docker.stack.namespace': 'nivaro' } }
  },
  {
    ID: 'sec-db-v2',
    CreatedAt: '2026-10-01T10:00:00Z',
    UpdatedAt: '2026-10-01T10:00:00Z',
    Spec: { Name: 'nivaro_db_password_v2', Labels: { 'com.docker.stack.namespace': 'nivaro' } }
  },
  {
    ID: 'sec-old-token',
    CreatedAt: '2026-08-01T10:00:00Z',
    Spec: { Name: 'legacy_token' }
  }
]
