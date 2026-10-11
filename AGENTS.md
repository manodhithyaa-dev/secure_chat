# SecureChat — Agent & Contributor Guide

SecureChat is an end-to-end encrypted chat MVP. Web-first: React + TypeScript + Vite
frontend, Node.js + Express + Socket.IO backend, SQLite (server) and IndexedDB
(browser). Flutter is intentionally out of scope for this phase.

## Repository layout

```
client/                 React + Vite + TypeScript web app
  src/crypto/           E2EE primitives (framework-independent)
  src/storage/          IndexedDB repositories behind a ChatStorage interface
  src/services/         REST + Socket.IO clients
  src/features/         Auth + chat state (React context)
  src/components/       UI
server/                 Express + Socket.IO API
  src/auth, users, friends, devices, messages, sockets
  src/database/         node:sqlite connection + migration runner
  migrations/           SQL migrations (ordered by filename)
  tests/                node:test integration tests
docs/                   Architecture, E2EE, offline delivery, API
```

## Commands

- Install: `npm install` (root, npm workspaces)
- Run both apps: `npm run dev` (server :4000, client :5173, Vite proxies /api and /socket.io)
- Backend only: `npm run dev:server`
- Frontend only: `npm run dev:client`
- Migrate DB: `npm run migrate`
- Server tests: `npm run test:server`
- Client tests: `npm run test:client`
- All tests: `npm test`
- Production build: `npm run build`

## Rules

- No new runtime dependency without a strong reason. SQLite is the Node built-in
  `node:sqlite` (requires Node >= 22.5). Password hashing uses `node:crypto` scrypt.
- Keep the crypto module free of React imports so Flutter can reuse the protocol.
- Never log or persist private keys, plaintext messages, or session tokens.
- The server must only ever receive ciphertext for message bodies.
- Backend is single-instance by design: no Redis, no external queue, no second DB.
- Enforce friendship before message submission (server-side, never trust the client).
- Re-use `messageId` on retries; dedup via the `messages.message_id` primary key.
- Distinguish Socket.IO transport delivery from recipient **persistence** ack.
- Keep `docs/IMPLEMENTATION_STATUS.md` current.

## Conventions

- Backend ESM (`"type": "module"`), parameterized SQL only.
- Frontend: function components + hooks, strict TypeScript.
- Update CHANGELOG.md for meaningful changes.
