# MoQ Architecture

This document explains how Media over QUIC (MoQ) works at the protocol level and how data flows through Cloudflare's relay network.

## Table of Contents

1. [Protocol Stack](#protocol-stack)
2. [Core Concepts](#core-concepts)
3. [Publishing Flow](#publishing-flow)
4. [Subscribing Flow](#subscribing-flow)
5. [Full End-to-End Flow](#full-end-to-end-flow)
6. [Cloudflare's Network](#cloudflares-network)
7. [Browser Implementation](#browser-implementation)

---

## Protocol Stack

MoQ is built on modern web transport technologies:

```
┌─────────────────────────────────────┐
│         Application (hang)          │  ← Media encoding/decoding
├─────────────────────────────────────┤
│         MoQ Transport               │  ← Pub/sub messaging
├─────────────────────────────────────┤
│         WebTransport                │  ← Browser API for QUIC
├─────────────────────────────────────┤
│         QUIC                        │  ← UDP-based transport
├─────────────────────────────────────┤
│         UDP                         │  ← Connectionless datagrams
└─────────────────────────────────────┘
```

### Why QUIC?

Unlike TCP, QUIC provides:
- **No head-of-line blocking**: Lost packets don't stall other streams
- **0-RTT connection establishment**: Faster reconnects
- **Built-in encryption**: TLS 1.3 integrated
- **Stream multiplexing**: Multiple independent streams per connection
- **Connection migration**: Survives network changes (WiFi → cellular)

### Why WebTransport?

WebTransport is the browser API that exposes QUIC to JavaScript:
- Bidirectional streams (like WebSocket but better)
- Unidirectional streams (for media delivery)
- Datagrams (unreliable, low-latency)
- Works through firewalls on port 443

---

## Core Concepts

### Namespace

A namespace is a unique identifier for a broadcast. Vivoh.earth uses 5-character stream IDs:
```
vivoh.earth/{streamId}
```

For example: `vivoh.earth/ab3x9`

Each stream ID is a 5-character lowercase alphanumeric string, auto-generated when starting a broadcast. The stream URL is simply `https://vivoh.earth/{streamId}`. The relay uses exact string matching - namespaces must match exactly between publisher and subscriber.

### Track

A track is a single media stream within a namespace:
- `audio` - Audio track
- `video` - Video track
- `catalog` - Metadata about available tracks

### Object

Objects are the fundamental unit of data in MoQ:
- Immutable chunks of media data
- Contain encoded audio/video frames
- Identified by (namespace, track, group, object)
- Can be delivered via streams or datagrams

### Group

A group is a collection of related objects:
- Typically corresponds to a GOP (Group of Pictures) in video
- Enables efficient seeking and late-join
- Subscribers can request "latest group" to minimize latency

---

## Publishing Flow

When a browser starts broadcasting, the following sequence occurs:

```
┌──────────────────┐                              ┌──────────────┐
│ Original         │                              │   Relay A    │
│ Publisher        │                              │ (Cloudflare) │
└────────┬─────────┘                              └──────┬───────┘
         │                                               │
         │  ┌─────────────────────────────────────────┐  │
         │  │ Publisher establishes MoQ session       │  │
         │  └─────────────────────────────────────────┘  │
         │                                               │
         │─────────── 1. CLIENT_SETUP ──────────────────▶│
         │                                               │
         │◀─────────── SERVER_SETUP ────────────────────│
         │                                               │
         │  ┌─────────────────────────────────────────┐  │
         │  │ Publisher asks permission to send track │  │
         │  └─────────────────────────────────────────┘  │
         │                                               │
         │─── 2. PUBLISH(namespace, track) ────────────▶│
         │                                               │
         │                          ┌───────────────────┐│
         │                          │ Relay confirms it ││
         │                          │ will accept       ││
         │                          └───────────────────┘│
         │                                               │
         │◀──────────── 3. PUBLISH_OK ──────────────────│
         │                                               │
         │  ┌─────────────────────────────────────────┐  │
         │  │ Publisher begins sending objects        │  │
         │  └─────────────────────────────────────────┘  │
         │                                               │
         │ ╔═══════════════════════════════════════════╗ │
         │ ║              Object Ingest                ║ │
         │ ║  ┌─────────────────────────────────────┐  ║ │
         │ ║  │               LOOP                  │  ║ │
         │ ║  └─────────────────────────────────────┘  ║ │
         │ ║                                           ║ │
         │ ║────────────── OBJECT ────────────────────▶║ │
         │ ║────────────── OBJECT ────────────────────▶║ │
         │ ║────────────── OBJECT ────────────────────▶║ │
         │ ║               ...                         ║ │
         │ ╚═══════════════════════════════════════════╝ │
         │                                               │
```

### Step-by-Step

1. **CLIENT_SETUP / SERVER_SETUP**
   - Publisher opens WebTransport connection to relay
   - Exchanges protocol version and role (publisher)
   - Establishes encrypted QUIC session

2. **PUBLISH (namespace, track)**
   - Publisher declares intent to send media
   - Specifies the namespace (e.g., `vivoh.earth/ab3x9`)
   - Lists tracks it will publish (audio, video)

3. **PUBLISH_OK**
   - Relay acknowledges and reserves resources
   - Publisher is now authorized to send objects

4. **OBJECT Loop**
   - Publisher continuously sends encoded media objects
   - Each object contains compressed audio/video data
   - Objects are sent on unidirectional QUIC streams
   - No acknowledgment required - fire and forget

---

## Subscribing Flow

When a browser wants to watch a stream:

```
┌──────────────────┐                              ┌──────────────┐
│ End              │                              │   Relay B    │
│ Subscriber       │                              │ (Cloudflare) │
└────────┬─────────┘                              └──────┬───────┘
         │                                               │
         │─────────── CLIENT_SETUP ─────────────────────▶│
         │◀─────────── SERVER_SETUP ────────────────────│
         │                                               │
         │─── SUBSCRIBE(namespace, track) ─────────────▶│
         │                                               │
         │◀──────────── SUBSCRIBE_OK ───────────────────│
         │                                               │
         │ ╔═══════════════════════════════════════════╗ │
         │ ║           Object Delivery                 ║ │
         │ ║                                           ║ │
         │ ║◀─────────────── OBJECT ───────────────────║ │
         │ ║◀─────────────── OBJECT ───────────────────║ │
         │ ║◀─────────────── OBJECT ───────────────────║ │
         │ ║               ...                         ║ │
         │ ╚═══════════════════════════════════════════╝ │
```

---

## Full End-to-End Flow

In production, publishers and subscribers connect to different edge relays. Cloudflare's control plane coordinates discovery:

```
┌───────────┐    ┌─────────┐    ┌───────────────┐    ┌─────────┐    ┌────────────┐
│ Original  │    │ Relay A │    │ Control Plane │    │ Relay B │    │    End     │
│ Publisher │    │  (Edge) │    │  (Cloudflare) │    │  (Edge) │    │ Subscriber │
└─────┬─────┘    └────┬────┘    └───────┬───────┘    └────┬────┘    └─────┬──────┘
      │               │                 │                 │               │
      │ ══════════════════════════════════════════════════════════════════│
      │   Endpoints establish MoQ sessions with their nearest relays      │
      │ ══════════════════════════════════════════════════════════════════│
      │               │                 │                 │               │
      │──CLIENT_SETUP▶│                 │                 │◀CLIENT_SETUP──│
      │◀SERVER_SETUP──│                 │                 │──SERVER_SETUP▶│
      │               │                 │                 │               │
      │ ══════════════════════════════════════════════════════════════════│
      │   Publisher makes its content discoverable                        │
      │ ══════════════════════════════════════════════════════════════════│
      │               │                 │                 │               │
      │──2.ANNOUNCE──▶│                 │                 │               │
      │ (namespace)   │                 │                 │               │
      │               │                 │                 │               │
      │               │ Relay A registers itself as source                │
      │               │──4.Register────▶│                 │               │
      │               │  (namespace,    │                 │               │
      │               │   self)         │                 │               │
      │               │◀─Registration───│                 │               │
      │               │    OK           │                 │               │
      │               │                 │                 │               │
      │◀─ANNOUNCE_OK──│                 │                 │               │
      │               │                 │                 │               │
      │ ══════════════════════════════════════════════════════════════════│
      │   Subscriber requests specific media                              │
      │ ══════════════════════════════════════════════════════════════════│
      │               │                 │                 │               │
      │               │                 │                 │◀──SUBSCRIBE───│
      │               │                 │                 │ (namespace,   │
      │               │                 │                 │  track)       │
      │               │                 │                 │               │
      │ ══════════════════════════════════════════════════════════════════│
      │   Relay B finds the source for the requested content              │
      │ ══════════════════════════════════════════════════════════════════│
      │               │                 │                 │               │
      │               │                 │◀──5.Query──────│               │
      │               │                 │  (namespace)    │               │
      │               │                 │                 │               │
      │               │                 │──Response──────▶│               │
      │               │                 │ (Source=Relay A)│               │
      │               │                 │                 │               │
      │ ══════════════════════════════════════════════════════════════════│
      │   Relay B forwards the subscription upstream                      │
      │ ══════════════════════════════════════════════════════════════════│
      │               │                 │                 │               │
      │               │◀──6.Forward─────────────────────│               │
      │               │    SUBSCRIBE    │                 │               │
      │◀──7.Forward───│                 │                 │               │
      │   SUBSCRIBE   │                 │                 │               │
      │   (namespace, │                 │                 │               │
      │    track)     │                 │                 │               │
      │               │                 │                 │               │
      │──SUBSCRIBE_OK▶│                 │                 │               │
      │               │──SUBSCRIBE_OK──────────────────▶│               │
      │               │                 │                 │──SUBSCRIBE_OK▶│
      │               │                 │                 │               │
      │ ══════════════════════════════════════════════════════════════════│
      │   The full data path is now established                           │
      │ ══════════════════════════════════════════════════════════════════│
      │               │                 │                 │               │
      │ ╔═════════════════════════════════════════════════════════════════╗
      │ ║                      Object Forwarding                          ║
      │ ╠═════════════════════════════════════════════════════════════════╣
      │ ║             │                 │                 │               ║
      │ ║──OBJECT────▶│                 │                 │               ║
      │ ║             │────────Forward OBJECT────────────▶│               ║
      │ ║             │                 │                 │──OBJECT──────▶║
      │ ║             │                 │                 │               ║
      │ ║──OBJECT────▶│                 │                 │               ║
      │ ║             │────────Forward OBJECT────────────▶│               ║
      │ ║             │                 │                 │──OBJECT──────▶║
      │ ║             │                 │                 │               ║
      │ ╚═════════════════════════════════════════════════════════════════╝
```

### Key Points

1. **Edge Proximity**: Both publisher and subscriber connect to their geographically nearest relay (anycast routing)

2. **Control Plane Discovery**: When Relay B receives a subscription for an unknown namespace, it queries the control plane to find which relay has the publisher

3. **Subscription Forwarding**: Relay B establishes a connection to Relay A and forwards the subscription request

4. **Object Forwarding**: Once the path is established, objects flow: Publisher → Relay A → Relay B → Subscriber

5. **Fan-out**: If 1000 subscribers connect to Relay B, Relay A only sends one copy to Relay B, which duplicates it locally

---

## Cloudflare's Network

Cloudflare operates 330+ data centers globally. Their MoQ relay runs at each edge location:

```
                                 ┌─────────────────┐
                                 │  Control Plane  │
                                 │   (Discovery)   │
                                 └────────┬────────┘
                                          │
           ┌──────────────────────────────┼──────────────────────────────┐
           │                              │                              │
    ┌──────▼──────┐               ┌───────▼──────┐              ┌───────▼──────┐
    │  Relay      │               │    Relay     │              │    Relay     │
    │  (NYC)      │◀─────────────▶│   (London)   │◀────────────▶│   (Tokyo)    │
    └──────┬──────┘               └───────┬──────┘              └───────┬──────┘
           │                              │                              │
     ┌─────┴─────┐                  ┌─────┴─────┐                  ┌─────┴─────┐
     │           │                  │           │                  │           │
┌────▼───┐ ┌─────▼────┐       ┌─────▼────┐ ┌────▼───┐        ┌────▼───┐ ┌─────▼────┐
│Publish │ │Subscribe │       │Subscribe │ │Publish │        │Subscribe│ │Subscribe │
│ (US)   │ │  (US)    │       │  (UK)    │ │ (UK)   │        │ (Japan) │ │ (Japan)  │
└────────┘ └──────────┘       └──────────┘ └────────┘        └─────────┘ └──────────┘
```

### Anycast Routing

When a browser connects to `relay.cloudflare.mediaoverquic.com`:
1. DNS returns an anycast IP address
2. The request is routed to the nearest data center
3. Latency is minimized for both publisher and subscriber

### Benefits

- **Low latency**: ~50-200ms end-to-end globally
- **Scalability**: Edge fan-out handles millions of subscribers
- **Reliability**: Automatic failover between data centers
- **No origin server**: The relay IS the infrastructure

---

## Browser Implementation

### WebCodecs

The browser uses WebCodecs to encode/decode media:

```javascript
// Encoding (Publisher)
const encoder = new VideoEncoder({
  output: (chunk) => {
    // Send chunk as MoQ object
    moqConnection.sendObject(chunk);
  },
  error: console.error
});

encoder.configure({
  codec: 'vp8',  // or 'avc1' for H.264
  width: 1280,
  height: 720,
  framerate: 30,
});

// Feed frames from camera
videoTrack.onframe = (frame) => {
  encoder.encode(frame);
};
```

```javascript
// Decoding (Subscriber)
const decoder = new VideoDecoder({
  output: (frame) => {
    // Render frame to canvas
    ctx.drawImage(frame, 0, 0);
    frame.close();
  },
  error: console.error
});

// Receive objects from MoQ
moqConnection.onobject = (object) => {
  decoder.decode(object.data);
};
```

### The hang Library

The `@kixelated/hang` library abstracts all of this. We define the elements in HTML and set the `url` and `name` attributes dynamically via JavaScript:

```html
<!-- HTML (attributes set by JavaScript) -->
<hang-publish audio video controls>
    <video slot="preview" muted autoplay></video>
</hang-publish>

<hang-watch controls>
    <canvas></canvas>
</hang-watch>
```

```javascript
// JavaScript sets the stream name based on stream ID
const streamId = getStreamId();  // from URL path or auto-generated (5 chars)
const streamName = `vivoh.earth/${streamId}`;

document.querySelector("hang-publish").setAttribute("url", RELAY_URL);
document.querySelector("hang-publish").setAttribute("name", streamName);
document.querySelector("hang-watch").setAttribute("url", RELAY_URL);
document.querySelector("hang-watch").setAttribute("name", streamName);
```

Under the hood, hang:
1. Opens WebTransport connection
2. Performs MoQ handshake (CLIENT_SETUP/SERVER_SETUP)
3. Sends ANNOUNCE or SUBSCRIBE based on role
4. Encodes camera/mic with WebCodecs (publish)
5. Decodes and renders to canvas (watch)
6. Handles reconnection and error recovery

---

## Latency Breakdown

Typical end-to-end latency for MoQ vs other protocols:

| Protocol | Latency | Use Case |
|----------|---------|----------|
| HLS/DASH | 10-30 seconds | VOD, large scale live |
| WebRTC | 200-500ms | 1:1 calls, small rooms |
| **MoQ** | **100-500ms** | **Live streaming at scale** |

MoQ achieves low latency through:
- No transcoding at relay (pass-through)
- QUIC's 0-RTT reconnection
- Edge delivery (no round-trip to origin)
- Dropping old frames instead of buffering

---

## References

- [IETF MoQ Transport Draft](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/)
- [WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)
- [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
- [Cloudflare MoQ Blog](https://blog.cloudflare.com/moq/)
- [moq.dev](https://moq.dev/)
