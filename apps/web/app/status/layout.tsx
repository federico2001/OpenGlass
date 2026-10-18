import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Status",
  description: "Live health of the OpenGlass API, database, evidence storage and platform keys.",
};

export default function StatusLayout({ children }: { children: ReactNode }) {
  return children;
}
