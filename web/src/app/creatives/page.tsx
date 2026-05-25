import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CreativesPanel } from "@/components/creatives/creatives-panel";

export default async function CreativesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <CreativesPanel username={user.username} role={user.role} />;
}
