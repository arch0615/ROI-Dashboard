import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { PlacementsPanel } from "@/components/placements/placements-panel";

export default async function PlacementsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // Members can also see the preview — it's read-only and respects scope.
  return <PlacementsPanel username={user.username} role={user.role} />;
}
