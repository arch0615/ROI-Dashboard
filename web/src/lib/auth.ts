import { cookies, headers } from "next/headers";

export type SessionUser = { id: number; username: string; role: "admin" | "member" | string };

// Server-side fetch of /api/auth/me. Forwards the session cookie so the
// backend can identify the user. Returns null when unauthenticated.
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("session");
  if (!sessionCookie) return null;

  const headerList = await headers();
  const host = headerList.get("host") ?? "127.0.0.1:3001";
  const proto = headerList.get("x-forwarded-proto") ?? "http";

  const res = await fetch(`${proto}://${host}/api/auth/me`, {
    headers: { cookie: `session=${sessionCookie.value}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { authenticated?: boolean; user?: SessionUser };
  return data.authenticated && data.user ? data.user : null;
}
