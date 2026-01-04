# Safari WebSocket Support - TODO

## Current Status (Jan 3, 2025)

**Video is working!** Safari can now receive video from Chrome broadcasts via our relay.

**Audio is not working.** Cloudflare immediately closes the audio subscription with `code=1`.

### What Works
- WebSocket connection from Safari to our relay
- MoQ session establishment over WebSocket
- Catalog subscription and delivery
- Video subscription and playback (subgroups mode)
- Stream finish() to prevent RESET_STREAM corruption

### What Doesn't Work
- Audio playback - Cloudflare closes audio subscription immediately

---

## Investigation Needed

### 1. Audio Track Mode Issue
**Symptom**: Cloudflare sends `SubscribeOk` for audio, then immediately sends `SubscribeDone { code: 1, reason: "closed, code=1" }`

**Hypothesis**: Chrome may be publishing audio as **datagrams** (common for low-latency audio), but Cloudflare can't relay datagrams to stream-based subscribers.

**Evidence**:
- Video uses subgroups mode (type=4 header) and works
- Audio subscription closes before any data is sent
- No audio frames appear in the relay logs

**Next Steps**:
- [ ] Check Chrome's console logs during broadcast to see what mode audio uses
- [ ] Check if hang library has option to force audio to use streams instead of datagrams
- [ ] Investigate Cloudflare's datagram relay capabilities

### 2. Alternative: Force Stream Mode for Audio
If Chrome is using datagrams for audio and Cloudflare can't relay them:
- [ ] Modify hang library to use streams for audio when publishing
- [ ] Or implement datagram-to-stream conversion at the relay (receiving side)

---

## Completed Work

### Stream Corruption Fix (Jan 3)
**Problem**: Safari showed "Unsupported stream type: 60, 61, 5..." garbage values

**Root Cause**: When streams are dropped without calling `finish()`, the WebSocket `SendStream::Drop` sends `RESET_STREAM` via priority channel, which races ahead of pending `STREAM` data frames. Safari receives RESET, closes stream, then interprets subsequent data as new streams.

**Fix** (commit a665b1c):
- Added `finish()` method to `transport::SendStream` trait
- Implemented for `web_transport::SendStream` and `WsSendStream`
- Added `finish()` to `Writer` class
- Call `finish()` at end of `serve_track`, `serve_subgroup`, and datagram fallback

### Upstream Subscribe (earlier)
- Relay forwards unknown subscribes to Cloudflare
- Creates Track with writer/reader pair
- Spawns background task to receive from Cloudflare
- Serves reader to Safari subscriber

### WebSocket Server (earlier)
- TLS WebSocket server on same port as QUIC
- `web-transport-ws` polyfill for stream multiplexing
- `WsSession` adapter for `moq_transport::transport::Session` trait

### Datagram Fallback (earlier)
- When `send_datagram()` fails (WebSocket doesn't support datagrams)
- Falls back to sending each datagram as a subgroup stream

---

## Files Changed (Recent)

### linode-moq-07 repo
- `moq-transport/src/transport.rs` - Added `finish()` to SendStream trait
- `moq-transport/src/session/writer.rs` - Added `finish()` method
- `moq-transport/src/session/subscribed.rs` - Call `finish()` on stream completion
- `moq-relay-ietf/src/ws_adapter.rs` - Implement `finish()` for WsSendStream
- `internal_crates/web-transport-ws/src/session.rs` - Diagnostic logging

---

## Architecture Reference

See `arch.md` section "Safari WebSocket Support" for diagrams.

---

## Quick Debug Commands

```bash
# View relay logs
ssh moq-relay 'journalctl -u moq-relay -f'

# Test Safari connection
# Open Safari, go to https://vivoh.earth/{stream-id}
# Check Console for errors

# Check what mode Chrome is using for audio
# Open Chrome DevTools while broadcasting
# Look for hang/moq logs about track modes
```
