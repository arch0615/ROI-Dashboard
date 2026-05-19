import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { RulesPanel } from "@/components/rules/rules-panel";

export default async function RulesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <RulesPanel username={user.username} />;
}
