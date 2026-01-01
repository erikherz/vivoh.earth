# Vivoh.Earth

MoQ (Media over QUIC) streaming application using Cloudflare's relay network.

## Architecture

- **Frontend**: Vite + [@kixelated/hang](https://www.npmjs.com/package/@kixelated/hang) v0.3.12 web components
- **Relay**: Cloudflare's public MoQ relay (`relay.cloudflare.mediaoverquic.com`)
- **Protocol**: IETF MoQ Transport draft-07
- **Hosting**: Cloudflare Workers (static assets)

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

### Broadcasting

1. Open https://vivoh.earth in Chrome
2. Click "Start" in the Broadcast section
3. Allow camera and microphone access
4. Your stream is now live on the Cloudflare relay

### Watching

1. Open https://vivoh.earth in another Chrome tab (or different device)
2. The Watch section will automatically connect to the stream
3. Click play if needed

### Custom Streams

The default namespace is `vivoh.earth/stream-001`. To use a different stream, modify the `name` attribute in `index.html`:

```html
<hang-publish
    url="https://relay.cloudflare.mediaoverquic.com"
    name="vivoh.earth/my-custom-stream"
    ...>
</hang-publish>

<hang-watch
    url="https://relay.cloudflare.mediaoverquic.com"
    name="vivoh.earth/my-custom-stream"
    ...>
</hang-watch>
```

**Note:** Use unique, unguessable names for private streams - the public relay has no authentication.

## Interoperability

See [interop.md](./interop.md) for details on MoQ protocol versions, library compatibility, and Cloudflare relay configuration.

**Key point:** This project uses `@kixelated/hang@0.3.12` specifically for compatibility with Cloudflare's draft-07 relay. Newer versions (0.4+) use draft-14 and won't connect.

## Links

- [Live Site](https://vivoh.earth)
- [Cloudflare MoQ Docs](https://developers.cloudflare.com/moq/)
- [MoQ Protocol](https://moq.dev/)
