# Authentication

Vivoh.Earth uses Google OAuth 2.0 for user authentication, implemented with Cloudflare Workers and D1.

## Architecture

```
Browser                    CF Worker                  Google OAuth
   │                          │                           │
   │── GET /api/auth/login ──>│                           │
   │<── Redirect to Google ───│                           │
   │────────────────────────────────── Login ────────────>│
   │<──────────────────────────────── code + state ───────│
   │── GET /api/auth/callback?code=xxx ─>│                │
   │                          │── Exchange code ─────────>│
   │                          │<── tokens ────────────────│
   │                          │── Fetch userinfo ────────>│
   │                          │<── user data ─────────────│
   │                          │── Upsert user (D1) ──────>│
   │<── Set session cookie ───│                           │
   │     + redirect home      │                           │
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | GET | Initiates OAuth flow, redirects to Google |
| `/api/auth/callback` | GET | Handles OAuth callback, creates session |
| `/api/auth/logout` | GET | Clears session cookie, redirects home |
| `/api/auth/me` | GET | Returns current user as JSON |

### GET /api/auth/me Response

```json
// Logged in
{
  "user": {
    "id": 1,
    "email": "user@gmail.com",
    "name": "John Doe",
    "avatar_url": "https://lh3.googleusercontent.com/..."
  }
}

// Not logged in
{
  "user": null
}
```

## Session Management

Sessions use **stateless signed cookies** with HMAC-SHA256:

- Cookie name: `session`
- Contains: `{ userId, exp }` + signature
- Flags: `HttpOnly`, `Secure` (production), `SameSite=Lax`
- Expiration: 7 days

No server-side session storage is required. The signature is verified on each request using the `SESSION_SECRET`.

## Database Schema

Users are stored in Cloudflare D1:

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_google_id ON users(google_id);
```

## File Structure

```
src/
├── auth.ts                    # Frontend: getCurrentUser(), login(), logout()
└── worker/
    ├── index.ts               # Worker entry point, API route handling
    ├── auth/
    │   ├── google.ts          # Google OAuth: auth URL, token exchange, userinfo
    │   └── session.ts         # Cookie signing/verification with Web Crypto API
    └── db/
        └── schema.sql         # D1 schema for users table
```

## Configuration

### Secrets (Cloudflare Dashboard or wrangler)

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put SESSION_SECRET
```

### Local Development

Create `.dev.vars` (gitignored):

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret
SESSION_SECRET=random-32-byte-base64-string
```

### Google Cloud Console Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create/select a project
3. Navigate to **APIs & Services > Credentials**
4. Create **OAuth client ID** (Web application)
5. Add authorized redirect URIs:
   - `https://vivoh.earth/api/auth/callback`
   - `http://localhost:8787/api/auth/callback`

## Security

- **CSRF Protection**: OAuth state parameter stored in HttpOnly cookie
- **Session Integrity**: HMAC-SHA256 signatures prevent tampering
- **Cookie Security**: HttpOnly prevents XSS, Secure ensures HTTPS
- **No Token Storage**: Google access tokens are never stored client-side

## Frontend Integration

```typescript
import { getCurrentUser, login, logout } from './auth';

// Check login state
const user = await getCurrentUser();
if (user) {
  console.log(`Logged in as ${user.name}`);
}

// Trigger login
document.getElementById('login-btn').onclick = login;

// Trigger logout
document.getElementById('logout-btn').onclick = logout;
```

## Dependencies

No external npm packages required. Uses:

- **Web Crypto API** (native to Workers) for HMAC signing
- **Cloudflare D1** for user storage
- **fetch()** for Google API calls
