// Microsoft OAuth 2.0 implementation for Cloudflare Workers

export interface MicrosoftTokens {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
}

export interface MicrosoftUser {
  id: string;
  mail: string | null;
  userPrincipalName: string;
  displayName: string;
}

// Generate the Microsoft OAuth authorization URL
export function getMicrosoftAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile User.Read",
    state: state,
    response_mode: "query",
  });

  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
}

// Exchange authorization code for tokens
export async function exchangeMicrosoftCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<MicrosoftTokens> {
  const response = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Microsoft token exchange failed: ${response.status} - ${error}`);
  }

  return response.json();
}

// Fetch user info from Microsoft Graph API
export async function getMicrosoftUserInfo(
  accessToken: string
): Promise<MicrosoftUser> {
  const response = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Microsoft user info: ${response.status}`);
  }

  return response.json();
}
