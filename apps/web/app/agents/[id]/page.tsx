import type { Metadata } from "next";
import { AgentProfile } from "../../../components/AgentProfile";
import layoutStyles from "../../directory/page.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Agent ${id}`,
    description: "Public, verifiable facts about this OpenGlass agent — never ratings, reviews, or session content.",
  };
}

export default async function AgentByIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className={`wrap ${layoutStyles.main}`}>
      <AgentProfile query={{ agentId: id }} />
    </main>
  );
}
