import process from "node:process";
import { verifyFrontendAssetGraph } from "./lib/frontendAssetGraph.mjs";

const baseUrl =
  process.env.ASSET_GRAPH_BASE_URL?.trim() ||
  process.env.E2E_BASE_URL?.trim() ||
  process.env.PRODUCTION_BASE_URL?.trim();

if (!baseUrl) {
  console.error("[asset-graph] FAIL: missing ASSET_GRAPH_BASE_URL.");
  process.exitCode = 1;
} else {
  verifyFrontendAssetGraph({
    baseUrl,
    label: process.env.ASSET_GRAPH_LABEL?.trim() || new URL(baseUrl).hostname,
  })
    .then(result => {
      console.log(
        `[asset-graph] PASS: routes=${result.routesChecked} assets=${result.assetsChecked} missing404=${result.missingAssetStatus}`
      );
    })
    .catch(error => {
      console.error(`[asset-graph] FAIL: ${error?.message || String(error)}`);
      process.exitCode = 1;
    });
}
