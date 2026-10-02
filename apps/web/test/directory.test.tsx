import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DirectoryPage from "../app/directory/page";
import { parseAgentId } from "../lib/agentId";

const VALID = "agt_01J8Z3K5M7N9P1Q3R5S7T9V1W3";

describe("parseAgentId", () => {
  it("accepts a well-formed agent ID", () => {
    expect(parseAgentId(VALID)).toBe(VALID);
  });

  it("trims whitespace and normalizes case to the canonical form", () => {
    expect(parseAgentId(`  ${VALID.toLowerCase()} \n`)).toBe(VALID);
  });

  it("rejects names, partial IDs, other ID kinds, and ULID-excluded letters", () => {
    expect(parseAgentId("Acme Bot")).toBeNull();
    expect(parseAgentId("acme.example")).toBeNull();
    expect(parseAgentId("agt_01J8Z3")).toBeNull();
    expect(parseAgentId(VALID.replace("agt_", "ses_"))).toBeNull();
    expect(parseAgentId(`${VALID}X`)).toBeNull();
    expect(parseAgentId("agt_01J8Z3K5M7N9P1Q3R5S7T9V1WU")).toBeNull();
    expect(parseAgentId("")).toBeNull();
  });
});

describe("GET /directory", () => {
  const html = renderToStaticMarkup(<DirectoryPage />);

  it("asks for an agent ID only, with no name search or listing", () => {
    expect(html).toContain("Find a registered agent");
    expect(html).toContain('aria-label="Agent ID"');
    expect(html).toContain('placeholder="agt_01J8Z3…"');
    expect(html).not.toContain("Search by name");
    expect(html).not.toContain("Verified only");
  });
});
