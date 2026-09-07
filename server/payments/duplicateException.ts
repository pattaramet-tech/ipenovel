import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

export async function findDuplicatePayments(tx: any, ref: string, paymentId: number) {
 const result = await tx.execute(sql`
 SELECT 'order' AS subjectType, p.id AS subjectId, o.id AS orderId,
 o.orderNumber AS label, p.status, o.totalAmount AS amount, p.approvedAt
 FROM payments p JOIN orders o ON o.id=p.orderId
 WHERE p.status='approved' AND p.id<>${paymentId}
 AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(p.extractedData),p.extractedData,'{}'),'$.providerVerification.bankTransactionReference'))=${ref}
 UNION ALL
 SELECT 'wallet', id, NULL, CONCAT('Topup #',id), status, requestedAmount, approvedAt
 FROM walletTopups WHERE status='approved'
 AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(extractedData),extractedData,'{}'),'$.providerVerification.bankTransactionReference'))=${ref}
 ORDER BY subjectType, subjectId`);
 return (Array.isArray(result[0]) ? result[0] : result) as any[];
}
export function duplicateConfirmationKey(ref: string, rows: any[], paymentId: number) {
 return createHash("sha256").update(JSON.stringify([paymentId, ref, rows.map(r=>[r.subjectType, Number(r.subjectId)])])).digest("hex");
}
export function validateDuplicateException(input: {confirmed: boolean; reason: string; confirmationKey: string}, ref: string, rows: any[], paymentId: number) {
 if (!input.confirmed || input.reason.trim().length < 5 || input.reason.trim().length > 1000)
  throw Error("DUPLICATE_EXCEPTION_REASON_REQUIRED");
 if (!rows.length || input.confirmationKey !== duplicateConfirmationKey(ref, rows, paymentId))
  throw Error("DUPLICATE_EXCEPTION_CHANGED_RECONFIRM");
}
