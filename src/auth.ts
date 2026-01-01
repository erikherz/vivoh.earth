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
