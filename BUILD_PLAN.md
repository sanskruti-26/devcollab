# BUILD_PLAN.md — 4 Day Sprint

All the code is already scaffolded in this repo. Your job each day is: install
deps, wire up env vars, run it, test it, fix whatever breaks (ask Claude Code to
debug), and capture a screenshot for your interview story. Same flow as the URL
shortener — you're running and testing, not writing from scratch.

---

## Day 1 — Get it running locally (Auth + Real-time sync + cursors)

1. Create a free MongoDB Atlas cluster: https://www.mongodb.com/atlas
   - Build a Database -> Free (M0) -> Create
   - Database Access -> Add a user (username + password)
   - Network Access -> Add IP -> "Allow access from anywhere" (0.0.0.0/0) for dev
   - Connect -> Drivers -> copy the connection string
2. Backend env:
   ```
   cp backend/.env.example backend/.env
   ```
   Fill in MONGODB_URI (paste Atlas string, replace <password>), and generate a JWT secret:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   Paste that as JWT_SECRET. Leave Judge0 keys blank for now.
3. Frontend env:
   ```
   cp frontend/.env.example frontend/.env
   ```
   (defaults are correct for local dev)
4. Install + run (TWO terminals):
   ```
   cd backend && npm install && npm run dev
   cd frontend && npm install && npm run dev
   ```
5. Open http://localhost:5173 -> Register -> you land on the Dashboard
6. Create a room -> you're in the editor
7. Copy the room URL, open it in a SECOND browser tab (or incognito + another account)
8. Type in one tab -> it appears in the other within ~1 second
9. Move your cursor / select text -> you see the other user's colored cursor + selection

**Done when**: two tabs sync code live, auth works, and live cursors show.

**If it breaks**: paste the exact error from the backend terminal to Claude Code.
Most common issue is a wrong MONGODB_URI (check password + that you allowed your IP).

---

## Day 2 — Test the rest of the features + persistence + code execution

1. Open the chat panel (message icon, top right) -> send a message -> it appears in both tabs
2. Check the top bar -> avatar circles show everyone in the room; close a tab -> that avatar disappears
3. Type code, refresh the page -> code persists (loaded from MongoDB)
4. Check Atlas -> Collections -> you should see users, rooms, messages
5. Watch the backend terminal -> "Room persisted" logs every ~3s while editing
6. (Optional but impressive) Enable code execution:
   - Sign up free at https://rapidapi.com/judge0-official/api/judge0-ce
   - Subscribe to the free Basic plan, copy your RapidAPI key
   - Add to backend/.env: JUDGE0_KEY=your_key, restart backend
   - Write console.log("hi"), click Run -> output appears in the bottom panel
   - Switch language to Python, write print(2+2), Run -> see 4
7. Ask Claude Code: "explain how live cursors and the version-tracked sync work" —
   read it, you'll need to explain this in interviews.

**Done when**: chat, presence, persistence, and (optionally) Run all work.

---

## Day 3 — Deploy

### Push to GitHub
```
git init
git add .
git commit -m "DevCollab: real-time collaborative code editor with live cursors"
gh repo create devcollab --public --push
```
(or create the repo manually on github.com and push)

### Deploy backend to Render (free)
1. render.com -> New -> Web Service -> connect your repo
2. Root Directory: backend
3. Build Command: npm install
4. Start Command: npm start
5. Add env vars (same as backend/.env): MONGODB_URI, JWT_SECRET, JWT_EXPIRES_IN,
   JUDGE0_URL, JUDGE0_KEY, and CLIENT_URL (set after you get the Vercel URL)
6. Create Web Service -> wait ~3 min -> copy your Render URL

### Deploy frontend to Vercel
1. vercel.com -> Add New Project -> import your repo
2. Root Directory: frontend
3. Env vars: VITE_API_URL and VITE_SOCKET_URL = your Render URL
4. Deploy -> copy the Vercel URL
5. Back on Render -> set CLIENT_URL to your Vercel URL -> Manual Deploy -> restart

**Done when**: the live Vercel link works end to end, two people can collaborate.

**Note:** Render's free tier sleeps after inactivity — the first request after a
while takes ~30s to wake up. That's normal; mention it's a free-tier thing, not a bug.

---

## Day 4 — Polish + README + interview prep

1. Test the live link from your phone + laptop at the same time (real demo!)
2. README is already written — update the live demo link at the top
3. Take screenshots for your portfolio:
   - Two windows side by side, both cursors visible, mid-edit (THE money shot)
   - The chat panel with messages
   - Code execution output
4. Practice explaining these (interviewers WILL ask):
   - "How does real-time sync work?" -> Socket.io rooms; server holds authoritative
     doc + version; broadcasts edits to everyone but the sender
   - "What if two people type at the exact same spot?" -> last-write-wins on the
     server; I track versions so I know when edits race. Full Google-Docs-style
     OT/CRDT is the next step — I can explain the difference
   - "How are live cursors done?" -> clients broadcast cursor position; others draw
     it as a Monaco decoration in that user's color
   - "How is it secured?" -> JWT on HTTP + sockets, bcrypt, rate limiting, helmet,
     input validation with zod, NoSQL-injection sanitization, sandboxed execution

**Done when**: live link + screenshots + you can confidently explain the architecture.

---

## What makes this stand out (say this in interviews)
- Most student "chat apps" just broadcast messages. This holds an **authoritative
  document with version tracking** and handles **concurrent editing** — a real
  distributed-systems problem.
- **Live cursors + presence** show you understand stateful real-time UX.
- **Auth on the WebSocket layer**, not just HTTP — a thing most people forget.
- **Production hardening** (rate limits, sanitization, security headers) shows you
  think about deployment, not just "it works on my machine."

## Stretch goals (after the deadline — turns it from great to exceptional)
- Replace last-write-wins with a CRDT (Yjs) for true conflict-free editing
- WebRTC voice chat in the room
- GitHub OAuth login
- Per-room permissions (view-only vs edit)

---

## Tight on time? Minimum viable path
If 4 days gets squeezed, this is the must-have order:
1. **Day 1 is non-negotiable** — sync + cursors running locally is the core demo
2. **Day 2** — at least get persistence working (refresh keeps code); Judge0 is optional
3. **Day 3** — deploy; a live link beats a local-only project for recruiters
4. **Day 4** — even just the README update + 2 screenshots is enough to submit

Worst case, a working **local** demo with screenshots is still a strong project —
deployment is a bonus, not a blocker for the hackathon registration.
