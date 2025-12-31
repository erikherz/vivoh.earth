
# Vivoh Earth 2.0 🌍

**High-Performance RTSP-over-QUIC Signaling Engine**

Vivoh Earth 2.0 is a modernized signaling server built on the **Cloudflare Workers** platform. It leverages **Durable Objects with SQLite persistence** to manage real-time stream state (SDP) at the edge, providing sub-10ms signaling latency for global video distribution.

## 🛠 Architecture

* **Runtime:** Cloudflare Workers (Runtime 2025)
* **State Management:** Durable Objects (SQLite-backed)
* **CI/CD:** GitHub Actions with Automated Secret Injection
* **Protocol:** RTSP 3.0 (Signaling Layer)
* **Security:** Header-based Stream Key Validation

---

## 🚀 API Reference

### 1. Stream Ingest (Camera)

Used by the source to register or update the Session Description Protocol (SDP).

* **Endpoint:** `POST /setup`
* **Header:** `X-Vivoh-Key: <your_stream_key>`
* **Body:** Raw SDP text block.

```bash
curl -X POST https://vivoh.earth/setup \
     -H "X-Vivoh-Key: your-secret-key" \
     -d "v=0..."

```

### 2. Stream Describe (Viewer)

Used by the playback client to retrieve the current stream metadata.

* **Endpoint:** `GET /describe`
* **Returns:** Enriched SDP including `x-vivoh-updated` timestamps.

```bash
curl https://vivoh.earth/describe

```

---

## 📦 Local Development

### Prerequisites

* Node.js 20+
* Wrangler CLI (`npm install -g wrangler`)

### Commands

| Command | Description |
| --- | --- |
| `npm install` | Install project dependencies |
| `npx wrangler dev` | Start local development server with DO support |
| `npx wrangler tail` | Stream live production logs to your terminal |
| `git push origin main` | Trigger automatic deployment to vivoh.earth |

---

## 🔐 Security & Environment

The following secrets must be configured in the Cloudflare Dashboard or via Wrangler:

* `VIVOH_STREAM_KEY`: The master key required for the `/setup` endpoint.
* `CLOUDFLARE_API_TOKEN`: Required for GitHub Actions deployment.

---

## 📅 Roadmap (2026)

* [x] Persistent Durable Object Storage (SQLite)
* [x] Custom Domain Mapping (`vivoh.earth`)
* [x] Secure Ingest Logic
* [ ] ???

---

