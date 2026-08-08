# Scramjet Proxy

A web proxy built on [Scramjet](https://github.com/MercuryWorkshop/scramjet) (MercuryWorkshop's
interception engine). It uses a real service worker + wisp transport, so it handles modern
JS-heavy sites, redirects, cookies, and even the target site's own service workers.

## API

```
/go/<base64url>
```

`<base64url>` is a base64url-encoded absolute URL. Visiting it registers the Scramjet
service worker and loads the target inside a Scramjet frame, which does all the
rewriting/redirect/cookie/SW handling.

Example — `https://example.com/`:

```
/go/aHR0cHM6Ly9leGFtcGxlLmNvbS8
```

There's also a landing page at `/` with a URL box.

## Run it

```bash
npm install
npm start        # http://localhost:3030  (PORT / HOST env override)
```

On first boot the server downloads the Scramjet client assets from npm into
`.scramjet-assets/` and starts the wisp transport.

## Hosting — important

Scramjet's model is: **browser service worker → wisp (WebSocket) → server with raw sockets → target.**
So it needs a host that can:

- accept **WebSocket upgrades** (for wisp), and
- open **raw outbound TCP/TLS sockets** to arbitrary targets.

**This rules out Wasmer serverless / Edge**, whose WASIX runtime cannot upgrade WebSockets and
returns `ENOSYS` on outbound `connect()`. Deploy on a normal Node host instead:

- Render / Railway / Fly.io / a VPS: run `npm start`. Works out of the box.

If you specifically want Wasmer to host the **frontend**, host these static assets there and point
the wisp transport at a separate socket-capable wisp server — Wasmer then never touches the target
network. (The all-in-one `server.js` here targets a Node host.)

## Files

- `server.js` — Express server: serves Scramjet assets + `/bootstrap-init.js` + `/sw.js`, runs the
  wisp transport on `upgrade`, and serves the `/go/<b64>` entry.
- `public/` — landing page (`index.html`, `index.js`, `style.css`).
