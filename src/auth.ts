// Frontend authentication utilities

export interface User {
  id: number;
  email: string;
  name: string;
  avatar_url: string;
}

export async function getCurrentUser(): Promise<User | null> {
  try {
    const response = await fetch("/api/auth/me");
    const data = await response.json();
    return data.user;
  } catch {
    return null;
  }
}

export function login(): void {
  window.location.href = "/api/auth/login";
}

export function logout(): void {
  window.location.href = "/api/auth/logout";
}
