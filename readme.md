# Vivoh.Earth

MoQ (Media over QUIC) streaming application using Cloudflare's relay network.

## Architecture

- **Frontend**: Vite + [@kixelated/hang](https://www.npmjs.com/package/@kixelated/hang) web components
- **Relay**: Cloudflare's public MoQ relay (`relay.cloudflare.mediaoverquic.com`)
- **Hosting**: Cloudflare Workers (static assets)

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

Open the app in two Chrome tabs to test broadcasting and watching.

The namespace `vivoh.earth/stream-001` is used for the default stream.
