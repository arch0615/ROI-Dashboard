"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AppHeader } from "../app-header";

type AdminUser = {
  id: number;
  username: string;
  role: "admin" | "member" | string;
  site_ids: string[];
  created_at: string;
  last_login_at: string | null;
};

type Site = { id: string; name: string; domain: string | null };

const input =
  "h-9 rounded-md bg-zinc-950 border border-zinc-800 px-3 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600";
const button =
  "h-9 px-3 rounded-md bg-zinc-100 text-zinc-950 text-sm font-medium disabled:opacity-50 hover:bg-white";
const ghost = "h-8 px-2 rounded-md text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800";

function SiteCheckboxes({
  sites,
  selected,
  onChange,
}: {
  sites: Site[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto p-2 rounded-md border border-zinc-800 bg-zinc-950">
      {sites.length === 0 && <span className="text-xs text-zinc-500">Nenhum site cadastrado.</span>}
      {sites.map((s) => {
        const on = selected.has(s.id);
        return (
          <label
            key={s.id}
            className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded cursor-pointer ${
              on ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"
            }`}
          >
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(s.id);
                else next.delete(s.id);
                onChange(next);
              }}
              className="accent-zinc-300"
            />
            {s.name}
          </label>
        );
      })}
    </div>
  );
}

function NewUserForm({ sites }: { sites: Site[] }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialPassword, setInitialPassword] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ user: AdminUser; initial_password: string | null }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, site_ids: Array.from(selected) }),
      }),
    onSuccess: (data) => {
      setInitialPassword(data.initial_password);
      setUsername("");
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold">Novo usuário</h2>
        <p className="text-xs text-zinc-500">
          O usuário só verá os sites marcados. A senha inicial aparece uma única vez — guarde antes de
          fechar.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!username) return;
          create.mutate();
        }}
      >
        <input
          className={`${input} w-full md:w-72`}
          placeholder="Nome de usuário"
          value={username}
          onChange={(e) => setUsername(e.target.value.trim())}
          required
        />
        <SiteCheckboxes sites={sites} selected={selected} onChange={setSelected} />
        <div className="flex items-center gap-2 flex-wrap">
          <button type="submit" className={button} disabled={create.isPending || !username}>
            {create.isPending ? "Criando..." : "Criar usuário"}
          </button>
          {create.isError && (
            <span className="text-sm text-rose-400">{(create.error as Error).message}</span>
          )}
        </div>
      </form>

      {initialPassword && (
        <div className="rounded-md border border-emerald-800 bg-emerald-950/60 p-3 text-sm space-y-2">
          <p className="text-emerald-200 font-medium">Usuário criado. Senha inicial:</p>
          <code className="block bg-zinc-950 border border-zinc-800 rounded px-2 py-1 font-mono text-zinc-100 select-all">
            {initialPassword}
          </code>
          <p className="text-xs text-emerald-300/80">
            Copie agora — ela não será exibida de novo. Você pode resetar via botão "Nova senha" depois.
          </p>
          <button
            type="button"
            onClick={() => setInitialPassword(null)}
            className={ghost}
          >
            Fechar
          </button>
        </div>
      )}
    </section>
  );
}

function UserRow({
  user,
  sites,
}: {
  user: AdminUser;
  sites: Site[];
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(user.site_ids));
  const [newPassword, setNewPassword] = useState<string | null>(null);
  useEffect(() => setSelected(new Set(user.site_ids)), [user.site_ids]);

  const saveSites = useMutation({
    mutationFn: () =>
      api<{ user: AdminUser }>(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ site_ids: Array.from(selected) }),
      }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
  const resetPw = useMutation({
    mutationFn: () =>
      api<{ new_password: string }>(`/api/admin/users/${user.id}/reset-password`, {
        method: "POST",
      }),
    onSuccess: (d) => setNewPassword(d.new_password),
  });
  const del = useMutation({
    mutationFn: () => api(`/api/admin/users/${user.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  const siteNames = useMemo(() => {
    const byId = new Map(sites.map((s) => [s.id, s.name]));
    return user.site_ids.map((id) => byId.get(id) ?? id);
  }, [user.site_ids, sites]);

  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {user.username}
            <span className="ml-2 text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 bg-zinc-800 text-zinc-300">
              {user.role}
            </span>
          </div>
          <div className="text-xs text-zinc-500">
            {user.role === "admin"
              ? "vê tudo"
              : siteNames.length === 0
                ? "sem sites vinculados"
                : `sites: ${siteNames.join(", ")}`}
            {user.last_login_at && (
              <span className="ml-2 text-zinc-600">último login {user.last_login_at}</span>
            )}
          </div>
        </div>
        {user.role !== "admin" && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              className={ghost}
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Cancelar" : "Editar"}
            </button>
            <button
              type="button"
              className={ghost}
              onClick={() => resetPw.mutate()}
              disabled={resetPw.isPending}
            >
              {resetPw.isPending ? "..." : "Nova senha"}
            </button>
            <button
              type="button"
              className={`${ghost} hover:text-rose-300`}
              onClick={() => {
                if (confirm(`Remover ${user.username}?`)) del.mutate();
              }}
              disabled={del.isPending}
            >
              Remover
            </button>
          </div>
        )}
      </div>

      {editing && (
        <div className="space-y-2 pt-1 border-t border-zinc-800">
          <SiteCheckboxes sites={sites} selected={selected} onChange={setSelected} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={button}
              onClick={() => saveSites.mutate()}
              disabled={saveSites.isPending}
            >
              {saveSites.isPending ? "Salvando..." : "Salvar acesso"}
            </button>
            {saveSites.isError && (
              <span className="text-sm text-rose-400">{(saveSites.error as Error).message}</span>
            )}
          </div>
        </div>
      )}

      {newPassword && (
        <div className="rounded-md border border-amber-800 bg-amber-950/40 p-2 text-xs space-y-1">
          <p className="text-amber-200 font-medium">Nova senha (visível apenas agora):</p>
          <code className="block bg-zinc-950 border border-zinc-800 rounded px-2 py-1 font-mono text-zinc-100 select-all">
            {newPassword}
          </code>
          <button type="button" className={ghost} onClick={() => setNewPassword(null)}>
            Fechar
          </button>
        </div>
      )}
    </li>
  );
}

export function AdminPanel({ username }: { username: string }) {
  const users = useQuery<AdminUser[]>({
    queryKey: ["admin-users"],
    queryFn: () => api<AdminUser[]>("/api/admin/users"),
  });
  const sites = useQuery<Site[]>({
    queryKey: ["sites"],
    queryFn: () => api<Site[]>("/api/sites"),
  });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader username={username} />
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Administração</h1>
          <p className="text-sm text-zinc-400">
            Crie usuários e atribua acesso por site. Membros só veem os sites marcados e não podem
            alterar configurações nem disparar sincronizações.
          </p>
        </div>

        <NewUserForm sites={sites.data ?? []} />

        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
          <div>
            <h2 className="text-base font-semibold">Usuários</h2>
            <p className="text-xs text-zinc-500">
              {users.isLoading
                ? "Carregando..."
                : `${users.data?.length ?? 0} usuário(s)`}
            </p>
          </div>
          {users.isError && (
            <p className="text-sm text-rose-400">{(users.error as Error).message}</p>
          )}
          <ul className="space-y-2">
            {users.data?.map((u) => (
              <UserRow key={u.id} user={u} sites={sites.data ?? []} />
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
