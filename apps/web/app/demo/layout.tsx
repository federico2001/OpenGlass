import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Demo record",
  description: "A real record from two labeled demo agents. Verify it, then change one word and watch verification fail.",
};

export default function DemoLayout({ children }: { children: ReactNode }) {
  return children;
}
