# Deploying SecureChat on a Tailscale tailnet

This guide publishes the Dockerized SecureChat app to your private Tailscale
network (your _tailnet_) over HTTPS, using **Tailscale Serve**. Nothing is
exposed to the public internet, and only devices signed into your tailnet can
reach it.

## Why Tailscale Serve (and not just the Tailscale IP)

Browsers only allow camera and microphone access in a **secure context**:
`https://` or `localhost`. Opening the app at `http://100.x.y.z:8080` over the
Tailscale IP is _not_ a secure context, so voice and video calls (`getUserMedia`)
would be blocked.

Tailscale Serve terminates TLS for you and automatically provisions a trusted
`*.ts.net` certificate for your node. That gives you:

- A real HTTPS origin: `https://<node>.<tailnet>.ts.net`
- Working camera/microphone for calls
- A `Secure` session cookie
- No public exposure — tailnet-only by default (use Funnel only if you
  deliberately want public access)

No application code changes are required: the client uses relative URLs and the
server already supports `trust proxy`, `CORS_ORIGIN`, and `COOKIE_SECURE`.

## Prerequisites

- Docker Engine + Docker Compose on the host.
- Tailscale installed and logged in on the host (`tailscale status` works).
- In the [Tailscale admin console](https://login.tailscale.com/admin/dns),
  one-time:
  1. Enable **MagicDNS**.
  2. Enable **HTTPS Certificates**.
     - Note: this publishes your node name and tailnet DNS name to the public
       Certificate Transparency ledger (a Tailscale requirement). No app data is
       exposed.

## 1. Configure environment

Copy the example env and set the two Tailscale values to your node's origin:

```bash
cp .env.example .env
```

```dotenv
# Exact HTTPS origin Tailscale Serve will expose (no trailing slash).
CORS_ORIGIN=https://securechat.<tailnet>.ts.net
COOKIE_SECURE=true
```

Find the origin with `tailscale status` (the MagicDNS name of the host) or it
will be printed when you run the Serve command below.

Optional WebRTC tuning (see [Calls and ICE](#calls-and-ice)):

```dotenv
# Leave unset for the default Google STUN, or empty to disable STUN entirely
# on a pure tailnet:
#   RTC_STUN_SERVERS=
```

## 2. Start the stack

```bash
docker compose up -d --build
```

nginx publishes its port on **loopback only** (`127.0.0.1:8080`), so it is not
reachable from the LAN or tailnet directly — only via Serve.

## 3. Publish with Tailscale Serve

```bash
scripts/tailscale-serve.sh
# or: tailscale serve --bg --https=443 http://127.0.0.1:8080
```

This prints something like:

```
https://securechat.<tailnet>.ts.net/
|-- / proxy http://127.0.0.1:8080
```

Check it any time with `tailscale serve status`. To stop sharing:
`tailscale serve --https=443 off`.

## 4. Access and verify

Open `https://<node>.<tailnet>.ts.net` on any tailnet device and:

1. Register / log in — the session cookie is set (devtools → Application →
   Cookies shows `sc_token` with `Secure`).
2. Send a message — devtools → Network → WS shows the Socket.IO transport
   upgraded to `websocket`.
3. Start an audio or video call — the browser prompts for microphone/camera
   (this is the secure-context payoff).
4. Upload an attachment — files stream through the proxy (up to 16 MiB).

Confirm privacy: `curl http://<lan-ip>:8080` and `curl http://<tailscale-ip>:8080`
should fail; only `http://127.0.0.1:8080` on the host and the `https://…ts.net`
URL should work.

## Calls and ICE

WebRTC media is peer-to-peer. On a tailnet every node is directly reachable
(no NAT between them), so ICE usually succeeds using host candidates and **TURN
is unnecessary**. The default STUN server is only used to discover candidates;
on an isolated network you can disable it with `RTC_STUN_SERVERS=`.

If your peers cannot connect directly (for example, restrictive local
firewalls between them), run a TURN server reachable on the tailnet and point
the app at it:

```dotenv
RTC_TURN_URL=turn:turn.<tailnet>.ts.net:3478
RTC_TURN_USERNAME=...
RTC_TURN_CREDENTIAL=...
```

TURN credentials stay server-side and are handed to authenticated clients via
`GET /api/v1/rtc-config`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Page loads but login never sticks | Cookie not sent over HTTP | Ensure you use the `https://…ts.net` URL and `COOKIE_SECURE=true` |
| Socket disconnects / 403 on `/socket.io` | `CORS_ORIGIN` doesn't match the origin exactly | Set `CORS_ORIGIN` to the exact `https://…ts.net` origin, no trailing slash, then restart |
| 502 from the `*.ts.net` URL | Stack not running, or Serve points at the wrong port | `docker compose ps`, then check `WEB_PORT` vs the Serve target |
| "Secure context" / no camera prompt | Accessing via `http://` or the raw Tailscale IP | Use the `https://…ts.net` URL from Serve |
| `tailscale serve` says HTTPS is not enabled | HTTPS certs/MagicDNS off | Enable both in the admin console DNS page |
| Calls connect but have no audio/video | Wrong device permissions | Grant mic/camera permission for the ts.net origin |

## Security notes

- Serve traffic is tailnet-only and subject to your tailnet ACLs. Use
  `tailscale funnel` only if you intentionally want public exposure (Funnel
  drops the Serve identity headers).
- The app still only ever stores ciphertext for message bodies.
- The port published by Docker is loopback-only; there is no direct LAN/tailnet
  access to the web container.
