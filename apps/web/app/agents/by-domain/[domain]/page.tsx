import type { Metadata } from "next";
import { AgentProfile } from "../../../../components/AgentProfile";
import layoutStyles from "../../../directory/page.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ domain: string }> }): Promise<Metadata> {
  const { domain } = await params;
  return {
    title: `Agents at ${domain}`,
    description: "Public, verifiable facts about the OpenGlass agent claiming this domain — never ratings, reviews, or session content.",
  };
}

export default async function AgentByDomainPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  return (
    <main className={`wrap ${layoutStyles.main}`}>
      <AgentProfile query={{ domain }} />
    </main>
  );
}
