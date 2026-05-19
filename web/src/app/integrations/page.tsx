import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { IntegrationsPanel } from "@/components/integrations/integrations-panel";

export default async function IntegrationsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <IntegrationsPanel username={user.username} />;
}
