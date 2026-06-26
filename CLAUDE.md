# Project: DevCollab — Real-time Collaborative Code Editor

## What this is
A collaborative code editor where multiple users can join a room and edit code
together in real time — like Google Docs but for code. Built to demonstrate
WebSockets, JWT auth, MongoDB persistence, and MERN stack.
Built in layers — see BUILD_PLAN.md for what's done vs. pending.

## Stack (locked — do not change without asking)
- Frontend: React + Vite + Tailwind CSS + Monaco Editor (@monaco-editor/react)
- Backend: Node.js + Express + Socket.io
- Database: MongoDB via Mongoose (MongoDB Atlas free tier)
- Auth: JWT (email + password, stored in MongoDB)
- Deploy: Vercel (frontend) + Render (backend)

## Conventions
- All API routes: `/api/v1/...`
- DB access only through Mongoose models in `backend/src/models/`
- Auth middleware: `backend/src/middleware/auth.js` — attach to any protected route
- Socket.io logic lives ONLY in `backend/src/services/roomService.js` — not in routes
- Frontend API calls: always through `frontend/src/lib/api.js` (axios instance with JWT interceptor)
- Socket client: always through `frontend/src/lib/socket.js` (singleton)
- All env vars: backend in `backend/.env`, frontend in `frontend/.env`
- Never hardcode URLs — always use env vars (VITE_API_URL, VITE_SOCKET_URL)
- Keep functions small and commented simply — the person building this is learning as they go, so prefer clear over clever
- After implementing a feature, give a short plain-English summary of what was built and why, before moving to the next task

## Current layer status
- [ ] Layer 1: Real-time sync — Socket.io, two users edit the same room live
- [ ] Layer 2: JWT Auth — signup/login, protected routes, JWT stored in localStorage
- [ ] Layer 3: MongoDB persistence — save rooms + code, auto-save every 5 seconds
- [ ] Layer 4: Room management — create, share link, join, participant list
- [ ] Layer 5: Polish + Deploy — language selector, Vercel + Render deploy, README

## Commands
- `cd backend && npm run dev` — start backend (port 5000, needs .env)
- `cd frontend && npm run dev` — start frontend (port 5173, needs .env)
- Both terminals must run simultaneously
- `cd backend && npm install` — install backend deps
- `cd frontend && npm install` — install frontend deps
