# DevCollab load test

A [k6](https://k6.io/) load test that simulates realistic concurrent usage of
DevCollab against the real multi-instance docker-compose stack
(`../docker-compose.yml`: `backend1` + `backend2` behind nginx round-robin,
sharing MongoDB + Redis) — not a single instance, not mocks.

It measures two things directly:

1. **Sync latency** — time from one client sending a Yjs edit to another
   client *in the same room* receiving the relayed edit.
2. **Reconnection time** — time from a dropped socket to that client being
   fully resynced (not just "socket open again" — able to send/receive real
   state).

## Why this isn't just `socket.io-client`

k6 scripts run in [goja](https://github.com/dop251/goja) (a pure-Go JS
engine), not Node — `require("socket.io-client")` isn't available. `script.js`
speaks the Engine.IO v4 / Socket.io v4 wire protocol directly over
`k6/websockets`. This is hand-rolled but small, stable, and was verified
against this exact stack before being written (see the comment block at the
top of `script.js` for the exact framing). Real Yjs update bytes are used
(not fake/arbitrary binary) — see [Fixtures](#fixtures) below.

## Prerequisites

- Docker (the test runs via the official `grafana/k6` image — no local k6
  install needed)
- The docker-compose stack, including nginx, running:
  ```
  cd ..
  docker compose up -d --build mongo redis backend1 backend2 nginx
  ```

## Running it

From `load-test/`, on Windows/Git-Bash, `MSYS_NO_PATHCONV=1` is required or
Git Bash mangles the container-side paths in `-v` and the script path:

```bash
MSYS_NO_PATHCONV=1 docker run --rm --network devcollab_default \
  -v "$(pwd):/scripts" -w /scripts \
  grafana/k6 run \
  -e ROOMS=20 -e USERS_PER_ROOM=5 -e RECONNECT_VUS=10 -e DURATION_S=120 \
  script.js
```

`--network devcollab_default` joins the test container to the compose
network so it can resolve `nginx` by service name (the default
`BASE_WS_URL`). Running k6 natively on the host instead: pass
`-e BASE_WS_URL=ws://localhost:8080`.

### Config (all via `-e KEY=value`)

| Var | Default | Meaning |
|---|---|---|
| `ROOMS` | 20 | Number of simulated rooms |
| `USERS_PER_ROOM` | 5 | Editors per room (total editor VUs = `ROOMS * USERS_PER_ROOM`) |
| `DURATION_S` | 120 | Test length in seconds |
| `TYPING_MIN_MS` / `TYPING_MAX_MS` | 1000 / 3000 | Randomized per-keystroke delay range — staggered, not synchronized, across VUs |
| `RECONNECT_VUS` | 10 | Separate VU pool dedicated to disconnect/reconnect churn |
| `RECONNECT_HOLD_MS` | 10000 | How long a reconnect-churn VU stays connected before dropping again |
| `BASE_WS_URL` | `ws://nginx:80` | Target — see above |
| `JWT_SECRET` | matches `docker-compose.yml`'s dev secret | Only override if you changed it |
| `DEBUG` | unset | Set to `1` to log every `ws.onerror` in detail (noisy — use for diagnosing failures, not routine runs) |

## Reading the output

k6 prints two kinds of numbers at the end of a run:

**Built-in WebSocket metrics** (`ws_*`) — connection-level health:
- `ws_connect_errors` / `ws_auth_errors` — should be **0**. Either one being
  non-zero means connections are failing before the app logic even runs;
  check the target is actually up and reachable first.
- `ws_connecting` — time to establish the WebSocket itself (not app-level
  sync). High values under load indicate the connection burst itself is a
  bottleneck (nginx, backend accept queue), separate from app logic.
- `ws_sessions` — total connections opened, including reconnects (so
  this is normally higher than the VU count).

**Custom metrics** (defined in `script.js`) — the actual things this test was
built to answer:
- `sync_latency_ms` — **the answer to "how fast do edits propagate."** Look at
  `p(90)`/`p(95)`, not just `avg` — one slow outlier (e.g. a connection still
  mid-handshake during a burst) skews the average far more than it should.
- `reconnect_time_ms` — **the answer to "how fast does a dropped user catch
  back up."**
- `yjs_updates_sent` vs `yjs_updates_received` — sanity check, not a target
  metric. Each send should be relayed to `(USERS_PER_ROOM - 1)` other
  clients, so `received ≈ sent × (USERS_PER_ROOM - 1)`. If that ratio is way
  off, something's wrong with room grouping or the relay itself, and the
  latency numbers above aren't trustworthy until it's fixed.
- `reconnect_cycles` — how many full disconnect→resync cycles completed
  across all `RECONNECT_VUS`, for context on how many `reconnect_time_ms`
  samples you're looking at.

Every `Trend` metric (`sync_latency_ms`, `reconnect_time_ms`) also gets k6's
standard `avg`/`min`/`med`/`max`/`p(90)`/`p(95)` breakdown for free — no
config needed.

## Real results (2026-07-09, this local docker-compose stack)

100 editors (20 rooms × 5) + 10 reconnect-churn VUs, 120s, run via the exact
command above:

```
sync_latency_ms.....: avg=31.14ms  min=1ms  med=4ms  max=3.37s  p(90)=23ms   p(95)=51ms
reconnect_time_ms...: avg=113.01ms min=57ms med=69ms max=764ms  p(90)=131.9ms p(95)=421.04ms
yjs_updates_sent....: 5861
yjs_updates_received: 23349   (ratio 3.98 — expected ~4 with USERS_PER_ROOM=5)
ws_connect_errors...: 0
ws_auth_errors......: 0
reconnect_cycles....: 110
```

Sync latency is excellent at this scale — sub-25ms at p90, meaning the
Redis pub/sub relay path (see `roomService.js`'s state-ownership comment) is
not a bottleneck yet. Reconnect time is dominated by the artificial 50ms
backoff floor plus TCP/WS handshake + Engine.IO/Socket.io CONNECT + a
`yjs-sync-request` round trip — p95 of 421ms is solid for a full resync, not
just a socket reopening.

**This test also found and caused a real crash** the first time it ran at
this scale: `backend1`/`backend2` died from an unhandled rejection inside
`@socket.io/redis-adapter`'s `fetchSockets()` (called by
`broadcastFilePresence()` on every `join-room` / `active-file-change` /
`yjs-sync-request` — under the initial connection burst, some of those
cross-instance calls timed out, and the adapter's internal timeout-cleanup
has a race that rejects an already-settled promise, orphaned from our own
`try/catch`). Fixed in `backend/src/server.js` with a process-level
`unhandledRejection` handler — a single flaky presence broadcast
shouldn't be able to take down every connected user. The numbers above are
from the run *after* that fix; see the git history for the fix itself.

### Tier 2: 500 editors — where it actually starts to strain

500 editors (100 rooms × 5) + 50 reconnect-churn VUs (same 10% ratio), 120s,
same command with `ROOMS=100 -e RECONNECT_VUS=50`:

```
sync_latency_ms.....: avg=17.15s  min=14ms    med=5.58s  max=1m30s  p(90)=1m2s   p(95)=1m7s
reconnect_time_ms...: avg=50.47s  min=34.17s  med=49.04s max=1m36s  p(90)=50.71s p(95)=1m34s
yjs_updates_sent....: 4119
yjs_updates_received: 7992
ws_connect_errors...: 520          (out of 612 total ws_sessions)
ws_auth_errors......: 0
ws_connecting.......: avg=22.7s   min=29ms    med=21.01s max=41.59s p(90)=39.92s p(95)=40.21s
reconnect_cycles....: 22
```

This is a real breaking point, not a graceful degradation — `sync_latency_ms`
p95 goes from 51**ms** at 100 editors to 67**seconds** at 500, and
`ws_connect_errors` alone (520) exceeds the entire editor count from tier 1.
`ws_connecting` (time to establish the WebSocket itself, before any app
logic) averaging 22.7s tells you most of this is a connection-admission
problem, not the sync/relay logic itself buckling.

**Backend1/backend2 did NOT crash this time** — `docker compose ps` showed
both still up throughout, confirming the `unhandledRejection` fix holds even
under 5x more load than what killed them before. But the log tally shows
exactly why the connection burst is so damaging:

```
broadcastFilePresence error: timeout reached while waiting for fetchSockets response   × 48
Unhandled rejection (server stays up): timeout reached ...                              × 7
```

`broadcastFilePresence()` — which does a cross-instance `io.in(roomId).fetchSockets()`
round trip via the Redis adapter — is called on **every** `join-room`,
`active-file-change`, *and* `yjs-sync-request`. At 550 connections all
joining/syncing within the same few-second burst, that's a large spike of
expensive cross-instance calls competing for the same Redis pub/sub channel
the adapter uses internally, and a meaningful fraction of them (48 logged,
plus the 7 that would have crashed the process pre-fix) time out. Each
timeout burns the adapter's default wait window doing nothing useful, adding
to event-loop pressure — a plausible direct contributor to `ws_connecting`
ballooning to 20-40s for everyone else trying to connect at the same time,
not just the requests that themselves timed out.

Also present but **not** a new scale-specific finding: `getOrCreateYDoc
hydration error` fired once per synthetic `loadtest-file-N` /
`loadtest-reconnect-file-N` (this test's fake, non-ObjectId file ids being
rejected by `File.findById`), same as the pre-existing `reconcileComments
error` / `File auto-save error` "Cast to ObjectId" noise seen at every scale
in this test — all caught, all harmless, just proportionally more log lines
at 5x the edit volume. Don't read these three as part of the strain finding.

One script-level caveat: a handful of `sendYjsUpdate` calls threw
`InvalidStateError` (trying to send on a socket that had already errored out
from underneath a VU mid-flight) — a robustness gap in `script.js` under
this much connection instability, not a masked app issue. It doesn't change
the finding above, but means the true failure count could be marginally
undercounted rather than overcounted.

**Diagnosis, not yet a fix**: the natural next step is reducing how often
`broadcastFilePresence()` actually needs to do a cross-instance fetch —
right now it re-fetches on every `yjs-sync-request`, which is far more
frequent than "who's viewing this room" actually changes. That's a real
optimization opportunity this load test surfaced, not something fixed here.

### What this means for the two tiers together

Somewhere between 100 and 500 concurrent editors there's a knee point where
`broadcastFilePresence`'s per-event `fetchSockets()` calls go from
"occasionally slow" to "actively starving the connection path." Narrowing
that down (e.g. try 200, 300) is the natural next investigation — see
[Scaling up from here](#scaling-up-from-here).

Don't take either tier's numbers as permanent baselines — re-run and update
this section whenever you materially change `roomService.js`, the Redis
integration, or the infra topology.

## Fixtures

`fixtures/generate-yjs-fixtures.js` (Node, run once — not part of the k6
runtime) pre-generates 2000 valid Yjs CRDT updates using the real `yjs`
package, each from an independent `Y.Doc` (so each simulated user has a
distinct CRDT identity, matching real concurrent-user behavior) with a
32-byte placeholder marker at a shared, verified-consistent byte offset.
`script.js` patches a live timestamp + VU id into that marker at send time
and reads it back out of the relayed bytes on receipt — that's how
`sync_latency_ms` is measured without needing a Yjs decoder inside k6 (the
server relays `yjs-update` bytes unchanged, so whatever bytes go in at the
sender come out unchanged at the receiver).

Regenerate only if you need more than 2000 concurrent editor VUs:

```bash
cd fixtures
npm install
npm run generate
```

## Scaling up from here

Current baseline (100 editors / 10 reconnect VUs / 120s) ran clean with the
`unhandledRejection` fix in place: 0 connection errors, sub-25ms p90 sync
latency, sub-500ms p95 reconnect time. Suggested progression, changing one
axis at a time so a regression is attributable:

1. **More rooms, same room size** — already know the two endpoints: 100
   editors (20 rooms) ran clean, 500 editors (100 rooms) broke badly (see
   [Tier 2](#tier-2-500-editors--where-it-actually-starts-to-strain)). The
   useful next step isn't going bigger, it's narrowing —
   `ROOMS=40 USERS_PER_ROOM=5` (200 editors), then `ROOMS=60` (300), to find
   the actual knee point between "clean" and "520 connect errors," and
   whether `ws_connecting` degrades gradually or falls off a cliff at some
   specific concurrency. Past that: `ROOMS=200` (1000 — the current fixture
   pool's ceiling; bump `POOL_SIZE` in `fixtures/generate-yjs-fixtures.js`
   and regenerate to go further). Watch `docker stats` on
   `backend1`/`backend2`/`redis` for CPU/memory pressure, and grep backend
   logs for `broadcastFilePresence error` / `Unhandled rejection` counts at
   each tier — tier 2 showed those scaling with the strain, not just present
   or absent.

2. **Bigger rooms, same room count** — hold `ROOMS` steady, raise
   `USERS_PER_ROOM` to 10, then 20. This is a *different* stress axis: each
   `yjs-update` fans out to `USERS_PER_ROOM - 1` recipients, so this scales
   relay fan-out and Redis pub/sub message volume per edit independently of
   total connection count. `yjs_updates_received` should scale roughly
   linearly with `USERS_PER_ROOM` for the same `yjs_updates_sent`.

3. **Gradual ramp vs the current all-at-once burst** — every VU in this
   script connects at test start (`per-vu-iterations` executor). That
   burst is deliberately what found the `fetchSockets()` crash, so keep it
   as a scenario, but also add a `ramping-vus` variant (k6 supports this as
   a separate `options.scenarios` entry) to see whether issues are
   specifically burst-triggered or appear under sustained load too, at the
   same eventual VU count.

4. **Longer soak, not just bigger burst** — `DURATION_S=1800` (30 min) or
   more at a moderate VU count, to catch slow leaks (Redis stream growth —
   see `STREAM_MAXLEN` in `roomService.js` — MongoDB connection pool
   behavior, memory growth in `backend1`/`backend2`) that a 2-minute run
   can't surface.

5. **Watch k6 itself, not just the app** — at high enough VU counts a single
   `grafana/k6` container generating the load becomes the bottleneck before
   the app does. `docker stats` on the k6 container during a run; if its
   CPU is pegged while the app's containers have headroom, the next step is
   distributing k6 itself (multiple k6 containers each driving a fraction
   of the VUs, or [k6's cloud output](https://k6.io/docs/results-output/real-time/k6-cloud/)),
   not necessarily scaling the app further.

6. **Mind the host, not just the containers** — this was developed and run
   on a resource-constrained local machine (Docker Desktop itself crashed
   from memory pressure earlier in this project's history — see git log).
   Real headroom numbers (how far this can scale before hitting host limits
   rather than app limits) will look different on real deployment
   infrastructure; re-baseline there before treating any ceiling found here
   as an application limit rather than a laptop limit.
