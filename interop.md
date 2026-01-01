# MoQ Interoperability Notes

This document explains the compatibility landscape between MoQ libraries and relays.

## Protocol Versions

The IETF MoQ Transport specification has evolved through multiple drafts:

| Draft | Status | Notes |
|-------|--------|-------|
| draft-07 | Cloudflare production | Limited subset |
| draft-14 | Current IETF | Full spec |
| moq-lite | moq-dev fork | Simplified protocol |

## Cloudflare Relays

Cloudflare operates two public MoQ relays:

| Relay | URL | Protocol |
|-------|-----|----------|
| Production | `relay.cloudflare.mediaoverquic.com` | draft-07 (subset) |
| Interop | `interop-relay.cloudflare.mediaoverquic.com` | draft-14 |

**Important:** The production relay only supports a "tiny subset" of draft-07. See [Cloudflare's MoQ blog post](https://blog.cloudflare.com/moq/) for details.

## @kixelated Packages

Luke Curley (kixelated) maintains two package families:

### @kixelated/hang (older)

Published on npm under the `@kixelated` scope.

| Version | Date | Protocol | Cloudflare Compatible |
|---------|------|----------|----------------------|
| 0.3.12 | Aug 21, 2025 | draft-07 | **Yes** |
| 0.4.x - 0.6.x | Sep-Oct 2025 | Transitional | Unknown |
| 0.7.0 | Nov 5, 2025 | draft-14 | No |

**Recommendation:** Use `@kixelated/hang@0.3.12` for Cloudflare's production relay.

### @moq/hang (newer)

Published on npm under the `@moq` scope from the [moq-dev/moq](https://github.com/moq-dev/moq) repo.

| Version | Date | Protocol |
|---------|------|----------|
| 0.1.0 | Dec 9, 2025 | moq-lite |

This is a fork of the IETF spec with a simpler "moq-lite" protocol. Compatibility with Cloudflare relays is unclear.

## Working Configuration

For Cloudflare's production relay (`relay.cloudflare.mediaoverquic.com`):

```json
{
  "dependencies": {
    "@kixelated/hang": "^0.3.12"
  }
}
```

In vivoh.earth v3.0, stream names are set dynamically via JavaScript based on room ID:

```javascript
const roomId = new URLSearchParams(window.location.search).get("room") || generateRoomId();
const streamName = `vivoh.earth/${roomId}`;

publisher.setAttribute("url", "https://relay.cloudflare.mediaoverquic.com");
publisher.setAttribute("name", streamName);
```

This ensures each session has a unique namespace, preventing conflicts.

## Browser Support

MoQ requires WebTransport, which has limited browser support:

| Browser | WebTransport | Status |
|---------|--------------|--------|
| Chrome 97+ | Yes | Recommended |
| Edge 97+ | Yes | Works |
| Firefox | Partial | Experimental |
| Safari | No | Not supported |

The `<hang-support>` element displays browser compatibility to users.

## Namespace Conventions

Cloudflare's relay uses exact string matching for namespaces:
- Use a unique prefix (e.g., `vivoh.earth/`) to avoid collisions
- Names are case-sensitive
- No authentication on public relay - use unguessable names for private streams

## References

- [MoQ Protocol](https://moq.dev/)
- [Cloudflare MoQ Blog](https://blog.cloudflare.com/moq/)
- [Cloudflare MoQ Docs](https://developers.cloudflare.com/moq/)
- [The First MoQ CDN](https://moq.dev/blog/first-cdn/)
- [@kixelated/hang npm](https://www.npmjs.com/package/@kixelated/hang)
- [moq-dev/moq GitHub](https://github.com/moq-dev/moq)
- [cloudflare/moq-rs GitHub](https://github.com/cloudflare/moq-rs)
