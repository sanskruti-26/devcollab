# DevCollab

[![Integration Tests](https://github.com/sanskruti-26/devcollab/actions/workflows/integration-tests.yml/badge.svg)](https://github.com/sanskruti-26/devcollab/actions/workflows/integration-tests.yml)

**Live demo:** [https://devcollab-eta.vercel.app]

> Render's free-tier backend sleeps after inactivity — the first request after a while can take ~30s to wake up. That's a free-tier limitation, not a bug.

DevCollab is a real-time collaborative code editor — Google Docs, but for code. Multiple developers join a room and edit the same files simultaneously, with changes merging conflict-free instead of clobbering each other, live cursors and selections rendered per-user, in-room chat, shared code execution, and an AI pair programmer that can see what you're working on. It's built to demonstrate the things a "two browser tabs and a websocket" toy demo glosses over: CRDT-based conflict resolution, comments that survive concurrent edits, and a persistence model that supports session replay.

---

## Architecture

```
┌──────────────────────┐        ┌──────────────────────┐
│   React Client A      │        │   React Client B      │
│   Monaco + y-monaco    │        │   Monaco + y-monaco    │
│   local Y.Doc (CRDT)   │        │   local Y.Doc (CRDT)   │
└───────────┬───────────┘        └───────────┬───────────┘
            │   yjs-update / yjs-sync          │
            │   cursor-move, chat, presence     │
            └──────────────┬────────────────────┘
                            │  Socket.io (WebSocket)
                            ▼
                  ┌───────────────────────┐
                  │   Express + Socket.io    │
                  │       backend server      │
                  │                            │
                  │  roomService.js            │
                  │   • authoritative Y.Doc     │
                  │     per file (server-side)  │
                  │   • merges + rebroadcasts    │
                  │     Yjs updates              │
                  │   • debounced Mongo writes   │
                  │   • comment anchor            │
                  │     reconciliation            │
                  └──────┬─────────────┬───────┘
                         │             │
            JWT (HTTP)   │             │  outbound HTTPS
                         ▼             ▼
              ┌─────────────────┐  ┌─────────────────────┐
              │     MongoDB        │  │   External services    │
              │  Rooms / Files /    │  │  • Judge0 (RapidAPI)     │
              │  Users / Messages /  │  │    sandboxed code run     │
              │  Comments / Snapshots │  │  • Google Gemini API      │
              │                       │  │    AI pair programmer      │
              └─────────────────────┘  └─────────────────────────┘
```

**Sync model:** each open file is a Yjs `Y.Doc`. The server holds the authoritative doc per file, applies incoming binary updates with `Y.applyUpdate`, rebroadcasts the same update to every other client in the room, and debounce-persists both the merged plaintext and the encoded Yjs state (`Y.encodeStateAsUpdate`) to MongoDB. New joiners — and the server itself after a cold start — get the full doc state from that same encoding rather than replaying history or reconstructing it from plaintext.

---

## Features

### Real-time collaboration
- **Yjs CRDT sync** — concurrent edits from multiple users merge deterministically with no central lock and no last-write-wins data loss, even with simultaneous edits at the same character position.
- **Live cursors & selections** — every participant's cursor and text selection renders as a Monaco decoration in a stable, per-user color.
- **Presence** — top bar shows who's in the room and which file each person currently has open, updated on join/leave/file-switch.
- **Typing indicators** — see who's actively typing before their edit lands.

### Editor
- **Monaco Editor** (the engine behind VS Code) with syntax highlighting for JavaScript, TypeScript, Python, Java, and C++.
- **Multi-file support** — each room has its own file tree; files can be created, renamed, and deleted, with language inferred from the file extension.
- **Theme switcher** — dark / light / high-contrast.
- **Auto-save** — debounced writes to MongoDB (5s after the last edit) so reloading never loses work.

### Collaboration tools
- **In-room chat** — persisted per room, replayed to anyone who joins later.
- **Inline code comments** — threaded discussions anchored to a specific line, with Yjs relative-position tracking so a comment thread follows its code through edits instead of going stale (see [Technical Highlights](#technical-highlights)).
- **Session replay** — step through a timeline of saved snapshots to watch how a room's code evolved.
- **Password-protected rooms** — optional bcrypt-hashed room password, owner always bypasses it.

### AI
- **AI pair programmer** — sidebar chat backed by Google Gemini (`gemini-2.5-flash`), aware of the current file or selected snippet, with conversation history for natural follow-ups ("now refactor that").

### Code execution
- **Run code in-room** — JavaScript, TypeScript, Python, Java, and C++ execute via [Judge0](https://judge0.com/) (RapidAPI), with output broadcast to everyone in the room.

---

## Technical Highlights

**Why a CRDT instead of last-write-wins.** Earlier in this project's history, the server held one "latest content" string and resolved concurrent edits by simply accepting whichever write arrived last — which silently drops a user's keystrokes whenever two people type near each other at the same time. The editor now uses [Yjs](https://docs.yjs.dev/), a CRDT (Conflict-free Replicated Data Type) implementation: every client keeps a local `Y.Doc`, edits are expressed as structured operations rather than raw strings, and merging two divergent docs is mathematically guaranteed to converge to the same result on every replica — no central coordination, no lost edits, no manual conflict resolution.

**Comments that survive edits — and server restarts.** A naive implementation anchors a comment to a line number, which drifts the moment someone edits a line above it. Instead, `routes/rooms.js` and `roomService.js` encode each comment's anchor as a Yjs *relative position* (`Y.encodeRelativePosition`) against the file's `Y.Text` — a reference to a specific character's identity in the CRDT, not its coordinates. After every batch of edits, `reconcileComments()` resolves each anchor's underlying Yjs item against the current document: if the item was deleted, the comment (and its thread) is cleanly removed; if it's still alive but the surrounding text shifted, the comment's displayed line number is recalculated and pushed to clients over `comment-relocated`. This is debounced per file so a burst of keystrokes triggers one reconciliation pass, not one per character. Relative positions only resolve against a `Y.Doc` that shares the CRDT history they were created against, so `File.yjsState` (the encoded `Y.encodeStateAsUpdate` output) is persisted on every save and replayed with `Y.applyUpdate` the next time the file is loaded — without it, a Render cold start would rebuild the doc from plaintext alone, hand every character a new identity, and silently freeze every existing anchor.

**Authoritative server-side Y.Doc per file, created exactly once.** A naive "create a Y.Doc if one doesn't exist yet" check is a race: two concurrent first-joiners can each see "doesn't exist," each construct their own `Y.Doc` with a different internal `clientID`, and from then on the two documents can never merge — edits silently vanish. `getOrCreateYDoc()` closes that race by storing the in-flight creation **promise** in a lock map the instant creation starts, so every concurrent caller awaits the same hydration work and receives the identical doc instance. Hydration itself prefers the persisted Yjs state described above, falling back to seeding from plaintext only for files saved before that field existed.

**JWT enforced on both the HTTP and WebSocket layers.** Most "auth-enabled" real-time apps only check the token on REST routes and leave the Socket.io connection open to anyone who can reach it — knowing a room ID is enough to join the live channel. Here, `middleware/auth.js` verifies `Authorization: Bearer` on every protected REST route (room access, file CRUD, comments, code execution), and `middleware/socketAuth.js` runs as `io.use()` middleware on every Socket.io handshake, decoding `socket.handshake.auth.token` with the same secret and payload shape before the connection is allowed to reach any room logic. A socket with a missing or invalid token is rejected before it ever sees a `connection` event. Downstream handlers (chat, code execution, cursor broadcasts) also trust `socket.user` — populated from the verified JWT — rather than any user-supplied name in the event payload, closing off identity spoofing at the transport layer.

**Session replay via append-only snapshots.** Rather than reconstructing history by replaying every Yjs update (expensive, and ties replay to the CRDT's internal format), the server writes a lightweight, event-sourcing-style snapshot — a flattened content string plus author and timestamp — on a debounced 2s cadence as edits land. Replay is just an ordered read of that collection. Snapshots auto-expire after 7 days via a MongoDB TTL index, so replay history doesn't grow Atlas storage unbounded.

**Security hardening actually in place.** `express-rate-limit` is applied at three granularities: a generous global limiter on `/api/v1/rooms` (200 req/min/IP, tuned for real-time polling), a strict login limiter (10 attempts/15min/IP) and registration limiter (5/hour/IP) to blunt credential stuffing, and a per-user AI limiter (20 req/min) keyed on the authenticated user ID, falling back to IP only if somehow unauthenticated. That fallback runs the IP through `express-rate-limit`'s `ipKeyGenerator` helper rather than using `req.ip` directly — required for IPv6 correctness, since v8 throws a validation error at startup if a raw IP is used as part of a custom rate-limit key. Passwords are bcrypt-hashed (both user accounts and optional room passwords) and never returned in API responses. `trust proxy` is explicitly scoped to one hop so `express-rate-limit` reads the real client IP behind Render's load balancer instead of either trusting a spoofable header or blocking every user behind the proxy as one IP. Code execution is isolated by delegating entirely to Judge0's sandboxed cloud runner rather than executing arbitrary user code in-process.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend framework | React 18 + Vite |
| Editor | Monaco Editor (`@monaco-editor/react`) |
| CRDT / real-time sync | Yjs, `y-monaco`, `y-protocols` |
| Styling | Tailwind CSS |
| Real-time transport | Socket.io (client + server) |
| Backend framework | Node.js + Express |
| Database | MongoDB Atlas via Mongoose |
| Auth | JWT (`jsonwebtoken`) + bcrypt password hashing |
| Rate limiting | `express-rate-limit` |
| Code execution | Judge0 CE (via RapidAPI) |
| AI pair programmer | Google Gemini API (`gemini-2.5-flash`) |
| Frontend hosting | Vercel |
| Backend hosting | Render |

---

## Local Setup

### Prerequisites
- Node.js 18+
- A free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster
- (Optional) A [Judge0 RapidAPI key](https://rapidapi.com/judge0-official/api/judge0-ce) for code execution
- (Optional) A [Google Gemini API key](https://aistudio.google.com/apikey) for the AI pair programmer

### 1. Clone and configure MongoDB Atlas
1. Create a free (M0) cluster at mongodb.com/atlas.
2. **Database Access** → add a database user (username + password).
3. **Network Access** → allow access from anywhere (`0.0.0.0/0`) for local dev.
4. **Connect → Drivers** → copy the connection string.

### 2. Backend
```bash
cd backend
cp .env.example .env
# Fill in MONGODB_URI (paste your Atlas string, replace <password>)
# Generate a JWT secret:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# Paste the output as JWT_SECRET in .env

npm install
npm run dev   # runs on http://localhost:5000
```

### 3. Frontend
```bash
cd frontend
cp .env.example .env   # defaults are correct for local dev
npm install
npm run dev   # runs on http://localhost:5173
```

Both servers must run simultaneously. Open `http://localhost:5173`, register an account, create a room, and open the room URL in a second tab (or incognito window) to see live sync in action.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default `5000`) | Port the Express/Socket.io server listens on |
| `MONGODB_URI` | **Yes** | MongoDB Atlas connection string |
| `JWT_SECRET` | **Yes** | Secret used to sign/verify JWTs — use a long random string |
| `CLIENT_URL` | **Yes** | Frontend origin, used for CORS and Socket.io's allowed origin |
| `JUDGE0_KEY` | No | RapidAPI key for Judge0 — without it, code execution returns a 503 with a clear setup message |
| `GEMINI_API_KEY` | No | Google Gemini API key — without it, the AI pair programmer returns a 503 with a clear setup message |

### Frontend (`frontend/.env`)

| Variable | Required | Description |
|---|---|---|
| `VITE_API_URL` | **Yes** | Base URL of the backend REST API (e.g. `http://localhost:5000`) |
| `VITE_SOCKET_URL` | **Yes** | Base URL the Socket.io client connects to (usually same as `VITE_API_URL`) |

---

## Deployment

- **Backend → Render:** Web Service, root directory `backend`, build `npm install`, start `npm start`. Set the same env vars as above, plus `CLIENT_URL` pointed at the deployed Vercel URL.
- **Frontend → Vercel:** root directory `frontend`, env vars `VITE_API_URL` / `VITE_SOCKET_URL` pointed at the deployed Render URL. `vercel.json` rewrites all routes to `index.html` for client-side routing.

Render's free tier spins down on inactivity, so the first request after idling takes ~30s to wake the backend up.

---

## Roadmap / Future Work

- **CRDT vs. operational transform** — Yjs (CRDT) was chosen over OT for simpler server logic (no transform functions, no central sequencing) at the cost of slightly larger update payloads; worth documenting the tradeoff explicitly for anyone evaluating both.
- **Per-room roles/permissions** — currently any participant can edit; view-only / editor / owner roles would support code-review-style rooms.
- **Multi-file session replay** — replay currently steps through room-wide snapshots; filtering replay to a single file's history is partially modeled (`Snapshot.fileId`) but not yet exposed in the UI.
- **WebRTC voice chat** — low-latency voice alongside text chat for pairing sessions.
- **GitHub OAuth login** — reduce signup friction vs. email/password only.
- **Security headers (helmet) and schema-level input validation (zod)** — current input handling relies on Mongoose schema constraints and manual checks in route handlers; a dedicated validation middleware layer would centralize this.
