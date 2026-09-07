import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { paymentProviderClaims } from "../../drizzle/schema";
export function parseProviderSnapshot(raw: string | null | undefined): any {
 try { return JSON.parse(raw ?? "{}").providerVerification ?? {}; } catch { return {}; }
}
export async function claimProviderTransaction(tx: any, type: "order" | "wallet", id: number, result: any) {
 const ref = result.bankTransactionReference;
 if (typeof ref !== "string" || !/^[A-Za-z0-9_.:-]{1,96}$/.test(ref)) throw Error("PROVIDER_REFERENCE_REQUIRED");
 const claimKey = createHash("sha256").update("bank-transaction:" + ref).digest("hex");
 // Unique key + row lock serializes cross-order/topup use on every app instance.
 await tx.insert(paymentProviderClaims).values({ claimKey, subjectType: type, subjectId: id })
  .onDuplicateKeyUpdate({ set: { claimKey } });
 const rows = await tx.select().from(paymentProviderClaims).where(eq(paymentProviderClaims.claimKey, claimKey)).limit(1).for("update");
 if (rows[0]?.subjectType !== type || rows[0]?.subjectId !== id) throw Error("PROVIDER_TRANSACTION_ALREADY_USED");
 // Protect approved provider snapshots predating this registry, without changing them.
 const historical = await tx.execute(sql`
 SELECT id FROM payments WHERE status = 'approved' AND NOT (${type} = 'order' AND id = ${id})
 AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(extractedData), extractedData, '{}'), '$.providerVerification.bankTransactionReference')) = ${ref}
 UNION ALL
 SELECT id FROM walletTopups WHERE status = 'approved' AND NOT (${type} = 'wallet' AND id = ${id})
 AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(extractedData), extractedData, '{}'), '$.providerVerification.bankTransactionReference')) = ${ref}
 LIMIT 1`);
 const found = Array.isArray(historical[0]) ? historical[0] : historical;
 if (found.length) throw Error("PROVIDER_TRANSACTION_ALREADY_USED");
}
