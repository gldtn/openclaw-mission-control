import { redirect } from "next/navigation";
import { CalendarProvidersView } from "@/components/calendar-providers-view";

export default function CalendarProvidersPage() {
  const isAgentbayHosted =
    process.env.AGENTBAY_HOSTED === "true" ||
    process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true";

  if (isAgentbayHosted) {
    redirect("/dashboard");
  }

  return <CalendarProvidersView />;
}
