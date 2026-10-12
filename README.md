# SecureChat

Web-first end-to-end encrypted chat MVP.

- **Frontend:** React + TypeScript + Vite (dark theme)
- **Backend:** Node.js + Express + Socket.IO
- **Server storage:** SQLite via the Node built-in `node:sqlite`
- **Browser storage:** IndexedDB (message history, identity key, encrypted outbox)

The server only ever stores metadata, public keys, hashed credentials/sessions, and a
temporary queue of ciphertext. Private keys and plaintext never leave the browser.

## Requirements

- Node.js **>= 22.5.0** (uses the built-in `node:sqlite` module). Tested on Node 26.
- npm (workspaces).

## Setup

```bash
npm install
cp .env.example .env       # optional; sensible defaults are built in
npm run migrate            # creates server/data/securechat.sqlite
```

## Run (development)

```bash
npm run dev
```

- Backend API: http://localhost:4000
- Frontend: http://localhost:5173 (Vite proxies `/api` and `/socket.io` to the backend)

## Run with Docker (single port)

The whole app runs behind nginx on one port. nginx serves the built SPA and
reverse-proxies `/api` and `/socket.io` (including the WebSocket upgrade) to the
backend container; only the nginx port is published.

```bash
docker compose up --build      # then open http://localhost:8080
```

- Change the published port with `WEB_PORT` (e.g. `WEB_PORT=9000 docker compose up`).
- SQLite and encrypted attachments persist in the `securechat-data` volume.
- `CORS_ORIGIN` defaults to `http://localhost:8080`; set it (and `WEB_PORT`) to the
  origin users actually visit.
- Session cookies are `Secure` only when `COOKIE_SECURE=true`. Over plain HTTP leave
  it `false`; behind a TLS terminator set it `true`.

Other commands:

```bash
npm run dev:server     # backend only, watch mode
npm run dev:client     # frontend only
npm run build          # type-check + production frontend build
npm test               # server (node:test) + client (vitest) suites
npx playwright install chromium   # one-time: download the E2E browser
npm run test:e2e       # Playwright end-to-end tests (isolated server + client)
```

## Try it

1. Open http://localhost:5173 in two browsers (or one normal + one private window).
2. Register two users.
3. From one user, go to **Friends**, search the other username, click **Add**.
4. The other user goes to **Requests** and clicks **Accept**.
5. Open the conversation and chat. Messages are encrypted on the sender device and
   decrypted on the recipient device.
6. Close the recipient tab and send a message: it is queued on the server. Reopen the
   recipient tab; pending ciphertext is delivered and acknowledged.

> **One device per account.** Each browser signs in as the account's single active
> device. Signing in from a new browser asks to sign the previous device out; the
> replaced device is disconnected and returned to the login screen.

## Configuration

See `.env.example`. All variables are optional and have defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | Backend port |
| `DATABASE_FILE` | `./data/securechat.sqlite` | SQLite path (relative to `server/`) |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed API origins (comma-separated) |
| `COOKIE_SECURE` | `true` in production | Mark the session cookie `Secure` (set `false` for plain-HTTP Docker) |
| `SESSION_TTL_MS` | 7 days | Session lifetime |
| `MESSAGE_TTL_MS` | 7 days | Offline queue expiry |
| `CLEANUP_INTERVAL_MS` | 1 hour | Expired-row cleanup interval |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | 60s / 120 | Per-IP API rate limit |

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/E2EE.md`](docs/E2EE.md)
- [`docs/OFFLINE_DELIVERY.md`](docs/OFFLINE_DELIVERY.md)
- [`docs/API.md`](docs/API.md)
- [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)

## Security limitations (read this)

The E2EE protocol is a **prototype** (static ECDH P-256 + HKDF-SHA-256 + AES-256-GCM)
with **no forward secrecy and no post-compromise security**. It is suitable for an MVP
and testing, not for production. Do not claim production-grade E2EE. See
[`docs/E2EE.md`](docs/E2EE.md) for the full list of limitations.
