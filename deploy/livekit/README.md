# LiveKit media server for large huddles

Huddles (Chat → headphones) are peer to peer: every person uploads one audio
stream per listener, which stops working past a handful of people. This bundle
runs a self-hosted [LiveKit](https://livekit.io) SFU the browsers move to once a
huddle grows past the size set under **Settings → Huddles → Large huddles**.
Each browser then uploads once and the server fans it out.

Nivaro keeps everything else: who is in the huddle, mute/share state, the
"started / ended" lines. LiveKit carries sound and shared screens only, and sees
rooms by an opaque hash — never a channel or record name.

## Files

| File | What |
|---|---|
| `docker-compose.yml` | One service, `livekit/livekit-server`, host networking |
| `livekit.yaml` | Server config template — fill in every `<...>` |

## Setup

1. Copy this folder to the media host (it can share a host with coturn).
2. Edit `livekit.yaml`:
   - `keys`: one API key/secret pair. Secret: `openssl rand -base64 32`.
   - `rtc.turn_servers`: the TURN server huddles already use (Settings →
     Huddles → TURN servers) with a long-term credential for LiveKit. On coturn
     add `user=<turn user>:<turn password>` to `turnserver.conf` (next to
     `use-auth-secret`, both can be on). Keep the coturn peer rules from the
     huddle docs (`denied-peer-ip` everything, `allowed-peer-ip` your ranges,
     `no-tcp-relay`).
   - `rtc.node_ip`: only when the host has no public interface of its own.
3. `docker compose up -d`, then `wget -qO- http://127.0.0.1:7880/` prints `OK`.
4. Put TLS in front: browsers connect over `wss://`, so terminate TLS on the
   proxy already in front of Nivaro (Traefik/nginx) and forward
   `media.example.com` → `http://<media host>:7880` **with websocket upgrade**.
   Only the signalling (7880) goes through the proxy; media uses the UDP range
   directly.
5. In Nivaro: **Settings → Huddles → Large huddles** — address
   `wss://media.example.com`, the API key and secret, and the size above which
   a huddle moves over (default 5). **Test media server** lists the server's
   rooms with the saved pair: a pass proves it is reachable from the API host
   and the key/secret match.

## Ports (firewall)

| Port | Proto | From | What |
|---|---|---|---|
| 7880 | TCP | the reverse proxy (or the API host + browsers if no proxy) | signalling websocket + HTTP API |
| 7881 | TCP | browsers | ICE over TCP for networks that block UDP |
| 50000–60000 | UDP | browsers | media |
| 3478 / 5349 | UDP+TCP / TCP | browsers | coturn (already open for huddles) |

The API host must reach 7880 (through the proxy is fine) for the token probe.
Nothing here needs to reach the database or Redis.

## Operating notes

- Rooms auto-create on first join and close five minutes after the last person
  leaves (`room.empty_timeout`).
- Join tokens are minted by the Nivaro API, last ten minutes, and name one room.
  Rotating the secret: change `keys`, restart LiveKit, paste the new secret
  under Settings. Running huddles reconnect on their next join.
- `docker compose logs -f livekit` is JSON; `level: debug` in `livekit.yaml`
  for ICE problems.
- Upgrade by bumping the image tag in `docker-compose.yml`; the config format is
  stable across 1.x.
