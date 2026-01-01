# Vivoh.Earth

MoQ (Media over QUIC) streaming application using Cloudflare's relay network.

## Architecture

- **Frontend**: Vite + [@kixelated/hang](https://www.npmjs.com/package/@kixelated/hang) v0.3.12 web components
- **Relay**: Cloudflare's public MoQ relay (`relay.cloudflare.mediaoverquic.com`)
- **Protocol**: IETF MoQ Transport draft-07
- **Hosting**: Cloudflare Workers (static assets only)

```
┌─────────────┐         ┌──────────────────────────────┐         ┌─────────────┐
│   Browser   │ ──────▶ │  relay.cloudflare.           │ ◀────── │   Browser   │
│ (Publisher) │  QUIC   │  mediaoverquic.com           │  QUIC   │ (Watcher)   │
│             │         │  (Cloudflare MoQ Relay)      │         │             │
│ hang-publish│         └──────────────────────────────┘         │ hang-watch  │
└─────────────┘                                                  └─────────────┘
       │                                                                │
       └──── Static HTML/JS served from vivoh.earth (CF Workers) ───────┘
```

## Requirements

- **Browser**: Chrome 97+ or Edge 97+ (WebTransport required)
- **Node.js**: 20+

## Development

```bash
npm install
npm run dev      # Start Vite dev server on localhost:3000
```

## Deploy

```bash
npm run deploy   # Build and deploy to Cloudflare
```

## Usage

### Room-Based Sessions

Each session uses a unique room ID for stream isolation:

- **Visit `vivoh.earth`** → Auto-generates a room (e.g., `?room=k7x2m9pa`)
- **Share the URL** → Others join the same room to watch
- **Click "+ New Room"** → Creates a fresh room

### Broadcasting

1. Open https://vivoh.earth in Chrome
2. A unique room ID is generated automatically
3. Click "Start" in the Broadcast section
4. Allow camera and microphone access
5. Share the URL with viewers

### Watching

1. Open the shared URL (e.g., `https://vivoh.earth?room=k7x2m9pa`)
2. The Watch section connects to that room's stream
3. Click play if needed

### Stream Namespace

Streams use the format: `vivoh.earth/{roomId}`

Each room maps to a unique namespace on the Cloudflare relay, preventing conflicts between sessions.

## Documentation

- [arch.md](./arch.md) - How MoQ works at the protocol level
- [interop.md](./interop.md) - Library versions and Cloudflare compatibility

## Interoperability

**Key point:** This project uses `@kixelated/hang@0.3.12` specifically for compatibility with Cloudflare's draft-07 relay. Newer versions (0.4+) use draft-14 and won't connect.

## Links

- [Live Site](https://vivoh.earth)
- [Cloudflare MoQ Docs](https://developers.cloudflare.com/moq/)
- [MoQ Protocol](https://moq.dev/)
