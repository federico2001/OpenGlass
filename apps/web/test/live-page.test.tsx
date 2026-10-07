import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LivePage from "../app/live/page";

describe("GET /live", () => {
  const html = renderToStaticMarkup(<LivePage />);

  it("breaks records into sessions and attestations", () => {
    expect(html).toContain("Active agents");
    expect(html).toContain(">Sessions<");
    expect(html).toContain(">Attestations<");
    expect(html).not.toContain("Verified records");
  });

  it("doesn't show a public-sessions count", () => {
    expect(html).not.toContain("Public sessions");
  });
});
