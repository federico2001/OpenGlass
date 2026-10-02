"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/** The public site's header and footer. The signed-in owner area (/dashboard) has its own
 * chrome (app/dashboard/layout.tsx), so these render nothing there. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/dashboard" || pathname?.startsWith("/dashboard/")) return null;
  return <>{children}</>;
}
