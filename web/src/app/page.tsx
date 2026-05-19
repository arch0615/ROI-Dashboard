import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-2xl font-semibold">ad-genius</h1>
        <p className="text-sm text-zinc-400">
          Olá, <span className="text-zinc-100">{user.username}</span>. Painel chega em M2.
        </p>
        <p className="font-mono text-xs text-zinc-600">
          {new Date().toISOString()}
        </p>
      </div>
    </main>
  );
}
