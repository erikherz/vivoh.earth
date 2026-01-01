// Discord OAuth 2.0 implementation for Cloudflare Workers

export interface DiscordTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  global_name: string | null;
  avatar: string | null;
  email: string | null;
}

// Generate the Discord OAuth authorization URL
export function getDiscordAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify email",
    state: state,
  });

  return `https://discord.com/oauth2/authorize?${params}`;
}

// Exchange authorization code for tokens
export async function exchangeDiscordCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<DiscordTokens> {
  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord token exchange failed: ${response.status} - ${error}`);
  }

  return response.json();
}

// Fetch user info from Discord API
export async function getDiscordUserInfo(
  accessToken: string
): Promise<DiscordUser> {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Discord user info: ${response.status}`);
  }

  return response.json();
}

// Get Discord avatar URL
export function getDiscordAvatarUrl(userId: string, avatarHash: string | null): string {
  if (!avatarHash) {
    // Default avatar based on discriminator (legacy) or user id
    const defaultIndex = Number(BigInt(userId) >> 22n) % 6;
    return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }
  const ext = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}`;
}
