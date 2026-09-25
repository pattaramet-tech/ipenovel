import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReadinessCard } from "./AdminNqaPage";

describe("M26 NQA readiness component", () => {
  it("renders READY without blockers", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReadinessCard, {
        title: "Full QA",
        ready: true,
        blockers: [],
        description: "Semantic pipeline",
      })
    );

    expect(html).toContain("Full QA");
    expect(html).toContain("READY");
    expect(html).toContain("No blockers.");
  });

  it("renders BLOCKED with bounded blocker codes", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReadinessCard, {
        title: "QC",
        ready: false,
        blockers: ["WORKSPACE_DOCS_CONNECTION_NOT_READY"],
        description: "QC readiness",
      })
    );

    expect(html).toContain("QC");
    expect(html).toContain("BLOCKED");
    expect(html).toContain("WORKSPACE_DOCS_CONNECTION_NOT_READY");
  });
});
