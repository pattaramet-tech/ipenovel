import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { NqaGatewayAuditRecord, NqaGatewayAuditSink } from "../mcp/audit";
import { resolveNqaAdminRunDirectory } from "./store";

export class JsonlNqaAdminGatewayAuditSink implements NqaGatewayAuditSink {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env
  ) {}

  async append(record: NqaGatewayAuditRecord): Promise<string> {
    const root = resolveNqaAdminRunDirectory(this.env);
    await fs.mkdir(root, { recursive: true });
    const auditRef = "nqa-admin-audit-" + randomUUID();
    const safeRecord = {
      ...record,
      auditRef,
    };
    await fs.appendFile(
      path.join(root, "gateway-audit.jsonl"),
      JSON.stringify(safeRecord) + "\n",
      "utf8"
    );
    return auditRef;
  }
}
