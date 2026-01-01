// Frontend authentication utilities

export interface User {
  id: number;
  email: string;
  name: string;
  avatar_url: string;
}

export type Provider = "google" | "microsoft" | "discord";

export async function getCurrentUser(): Promise<User | null> {
  try {
    const response = await fetch("/api/auth/me");
    const data = await response.json();
    return data.user;
  } catch {
    return null;
  }
}

// Generic login - defaults to Google for backwards compatibility
export function login(): void {
  window.location.href = "/api/auth/google/login";
}

// Provider-specific login functions
export function loginWithGoogle(): void {
  window.location.href = "/api/auth/google/login";
}

export function loginWithMicrosoft(): void {
  window.location.href = "/api/auth/microsoft/login";
}

export function loginWithDiscord(): void {
  window.location.href = "/api/auth/discord/login";
}

export function logout(): void {
  window.location.href = "/api/auth/logout";
}

// Stats logging functions
export async function logBroadcastStart(streamId: string): Promise<number | null> {
  try {
    const response = await fetch("/api/stats/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.id;
  } catch {
    return null;
  }
}

export async function logBroadcastEnd(eventId: number): Promise<void> {
  try {
    await fetch(`/api/stats/broadcast/${eventId}/end`, { method: "POST" });
  } catch {
    // Ignore errors
  }
}

export async function logWatchStart(streamId: string): Promise<number | null> {
  try {
    const response = await fetch("/api/stats/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.id;
  } catch {
    return null;
  }
}

export async function logWatchEnd(eventId: number): Promise<void> {
  try {
    await fetch(`/api/stats/watch/${eventId}/end`, { method: "POST" });
  } catch {
    // Ignore errors
  }
}

// Stream settings functions
export async function getStreamSettings(streamId: string): Promise<{ require_auth: boolean }> {
  try {
    const response = await fetch(`/api/streams/${streamId}`);
    const data = await response.json();
    return { require_auth: data.require_auth ?? false };
  } catch {
    return { require_auth: false };
  }
}

export async function updateStreamSettings(streamId: string, requireAuth: boolean): Promise<void> {
  try {
    await fetch("/api/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId, require_auth: requireAuth }),
    });
  } catch {
    // Ignore errors
  }
}
