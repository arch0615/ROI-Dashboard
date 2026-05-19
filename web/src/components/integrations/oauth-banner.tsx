"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function OAuthBanner() {
  const router = useRouter();
  const [state, setState] = useState<
    { kind: "ok" | "error"; message: string } | null
  >(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("google_oauth");
    if (!status) return;
    if (status === "ok") {
      const n = params.get("accounts") ?? "0";
      setState({ kind: "ok", message: `Google conectado: ${n} conta(s) salva(s).` });
    } else if (status === "error") {
      setState({
        kind: "error",
        message: params.get("message") ?? "Falha na autorização Google.",
      });
    }
    // Clean the query so a refresh doesn't reshow the banner.
    router.replace("/integrations");
  }, [router]);

  if (!state) return null;
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm ${
        state.kind === "ok"
          ? "border-emerald-800 bg-emerald-950/60 text-emerald-200"
          : "border-rose-800 bg-rose-950/60 text-rose-200"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <p>{state.message}</p>
        <button
          type="button"
          onClick={() => setState(null)}
          className="text-xs opacity-70 hover:opacity-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
