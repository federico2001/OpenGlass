import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../../components/app/AppShell";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
