import type { ReactNode } from "react";

export const metadata = {
  title: "OpenGlass",
  description: "A neutral witness for agent-to-agent interactions.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem" }}>{children}</body>
    </html>
  );
}
