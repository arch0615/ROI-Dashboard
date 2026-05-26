import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import LoginForm from "./login-form";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-zinc-100">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl bg-white shadow-sm border border-zinc-200 px-8 py-10">
          <div className="text-center space-y-1 mb-7">
            <h1 className="text-2xl font-semibold text-zinc-900">ROI Dashboard</h1>
            <p className="text-sm text-zinc-500">Entrar no painel</p>
          </div>
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
