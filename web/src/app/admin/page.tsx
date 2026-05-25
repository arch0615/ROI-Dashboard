import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { AdminPanel } from "@/components/admin/admin-panel";

export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  return <AdminPanel username={user.username} />;
}
