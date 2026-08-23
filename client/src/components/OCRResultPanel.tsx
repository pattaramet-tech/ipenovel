import { Badge } from "@/components/ui/badge";
import {
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  EyeOff,
  MinusCircle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
  buildChecklist,
  canRecheckOcr,
  requiresLegacyCaseResolution,
  compareTransactionTime,
  deriveVerdict,
  describeDuplicate,
  verdictLabel,
  type CheckState,
  type OcrPanelInput,
  type OcrVerdict,
} from "./ocrVerdictModel";

/**
 * Admin OCR Detail panel.
 *
 * Everything an admin needs to answer "what happened and why" is derived by
 * ocrVerdictModel.ts (pure, unit tested) and merely rendered here. Raw JSON
 * remains available but is deliberately LAST - no admin should have to read
 * it to learn the root cause.
 */

interface OCRResultPanelProps {
  payment: {
    id: number;
    status?: string | null;
    extractedData?: string | Record<string, any> | null;
    ocrDecision?: string | null;
    ocrConfidence?: number | null;
    fingerprint?: string | null;
    reviewReason?: string | null;
    approvalSource?: string | null;
    slipSubmittedAt?: string | Date | null;
    order?: { totalAmount: number | string };
  };
  /**
   * Server-derived OCR metadata from admin.orders.detail. Carries the
   * EFFECTIVE freshness window and the server's duplicate finding, so the
   * panel never recomputes either from a hard-coded constant.
   */
  ocrMeta?: {
    effectiveWindowMinutes?: number;
    minConfidence?: number;
    duplicate?: {
      strength: "strong";
      kind: string;
      matchedSourceType: "order_payment" | "wallet_topup";
      matchedSourceId: number;
      viaLegacyCompatibility: boolean;
    } | null;
    fileIdentifierStatus?: "AVAILABLE" | "MATCH" | "UNAVAILABLE";
    recipient?: {
      recipientVerified?: boolean;
      recipientEvidenceType?: string;
      recipientEvidenceStrength?: string;
    } | null;
  } | null;
  /** Called after a successful recheck so the parent can refetch. */
  onRecheckComplete?: () => void;
}

function parseExtracted(value: OCRResultPanelProps["payment"]["extractedData"]) {
  if (!value) return null;
  if (typeof value !== "string") return value as Record<string, any>;
  try {
    return JSON.parse(value) as Record<string, any>;
  } catch {
    // A corrupt blob must not blank the whole panel - the rest of the
    // payment's state is still worth showing.
    return null;
  }
}

function StateIcon({ state }: { state: CheckState }) {
  switch (state) {
    case "pass":
      return <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" aria-hidden />;
    case "fail":
      return <AlertCircle className="w-4 h-4 text-red-600 shrink-0" aria-hidden />;
    case "warning":
      return <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0" aria-hidden />;
    default:
      return <MinusCircle className="w-4 h-4 text-slate-400 shrink-0" aria-hidden />;
  }
}

const STATE_LABEL: Record<CheckState, string> = {
  pass: "PASS",
  fail: "FAIL",
  warning: "WARNING",
  not_evaluated: "NOT EVALUATED",
};

const STATE_CLASS: Record<CheckState, string> = {
  pass: "bg-green-100 text-green-800",
  fail: "bg-red-100 text-red-800",
  warning: "bg-yellow-100 text-yellow-800",
  not_evaluated: "bg-slate-100 text-slate-600",
};

function VerdictBanner({ verdict }: { verdict: OcrVerdict }) {
  const tone =
    verdict === "auto_approved"
      ? "bg-green-50 border-green-300 text-green-900"
      : verdict === "ready_for_admin_approval"
        ? "bg-blue-50 border-blue-300 text-blue-900"
        : verdict === "ocr_disabled"
          ? "bg-slate-50 border-slate-300 text-slate-800"
          : "bg-yellow-50 border-yellow-300 text-yellow-900";

  return (
    <div className={`rounded-lg border-2 p-4 ${tone}`}>
      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">OCR Verdict</p>
      <p className="text-xl font-bold mt-1 flex items-center gap-2">
        {verdict === "auto_approved" && <CheckCircle2 className="w-5 h-5" aria-hidden />}
        {verdict === "ready_for_admin_approval" && <CheckCircle2 className="w-5 h-5" aria-hidden />}
        {verdict === "needs_review" && <AlertTriangle className="w-5 h-5" aria-hidden />}
        {verdict === "ocr_disabled" && <EyeOff className="w-5 h-5" aria-hidden />}
        {verdictLabel(verdict)}
      </p>
    </div>
  );
}

export function OCRResultPanel({ payment, ocrMeta, onRecheckComplete }: OCRResultPanelProps) {
  const [showRawJson, setShowRawJson] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [resolutionReason, setResolutionReason] = useState("");
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [resolutionDone, setResolutionDone] = useState<string | null>(null);
  const [recheckResult, setRecheckResult] = useState<any | null>(null);

  const extracted = parseExtracted(payment.extractedData);

  // Sanitized attempt history - no raw OCR text, no secrets (the server
  // strips both; see ocrAttemptService.sanitizeSnapshot).
  const attemptsQuery = (trpc as any).admin?.orders?.ocrAttempts?.useQuery?.(
    { paymentId: payment.id },
    { enabled: Boolean(payment.id) }
  );

  const resolveAmbiguity = (trpc as any).admin?.orders?.resolveLegacyCaseAmbiguity?.useMutation?.({
    onSuccess: (data: any) => {
      setResolutionDone(
        data?.decision === "confirmed_distinct"
          ? "Approved as a distinct transaction."
          : "Rejected as a duplicate."
      );
      setResolutionError(null);
      onRecheckComplete?.();
    },
    onError: (error: any) => {
      setResolutionError(error?.message || "Resolution failed. Please try again.");
      setResolutionDone(null);
    },
  });

  const recheck = (trpc as any).admin?.orders?.recheckOcr?.useMutation?.({
    onSuccess: (data: any) => {
      setRecheckResult(data);
      setRecheckError(null);
      attemptsQuery?.refetch?.();
      onRecheckComplete?.();
    },
    onError: (error: any) => {
      setRecheckError(error?.message || "Recheck failed. Please try again.");
      setRecheckResult(null);
    },
  });

  if (!extracted && !payment.ocrDecision && !payment.reviewReason && !payment.approvalSource) {
    return null;
  }

  // A completed recheck supersedes the stored snapshot for display purposes;
  // it never changes the payment itself.
  const model: OcrPanelInput = {
    ocrDecision: payment.ocrDecision,
    reviewReason: recheckResult?.reviewReason ?? payment.reviewReason,
    ocrConfidence: recheckResult?.ocrConfidence ?? payment.ocrConfidence,
    paymentStatus: payment.status,
    readyForAdminApproval: recheckResult?.readyForAdminApproval === true,
    extracted: extracted as OcrPanelInput["extracted"],
    expectedAmount: payment.order?.totalAmount != null ? Number(payment.order.totalAmount) : null,
    slipSubmittedAt: payment.slipSubmittedAt ?? null,
    // The EFFECTIVE window the server actually verified against. Previously
    // hard-coded to 120, which disagreed with any deployment configured
    // differently and could show PASS for a slip the server sent to review.
    allowedWindowMinutes:
      recheckResult?.effectiveWindowMinutes ?? ocrMeta?.effectiveWindowMinutes ?? null,
    legacyFingerprint: payment.fingerprint,
    providerDiagnostic: recheckResult?.providerDiagnostic ?? null,
    rootCauseSummary: recheckResult?.rootCauseSummary ?? null,
    category: recheckResult?.category ?? null,
    // Server-derived duplicate finding. Never inferred from a legacy
    // fingerprint - an old opaque fingerprint is shown as LEGACY / WEAK.
    duplicate: recheckResult?.duplicate ?? ocrMeta?.duplicate ?? null,
    // Server verdict is authoritative; the model falls back to display-only
    // local grading solely for rows the server could not grade.
    serverRecipient: ocrMeta?.recipient ?? null,
    fileIdentifierStatus:
      recheckResult?.fileIdentifierStatus ?? ocrMeta?.fileIdentifierStatus ?? null,
  };

  const verdict = deriveVerdict(model);
  const checklist = buildChecklist(model);
  const duplicate = describeDuplicate(model);
  const time = compareTransactionTime(model);
  const rootCause = model.rootCauseSummary;
  const referenceValue = extracted?.referenceRaw ?? extracted?.reference;
  const recheckAvailable = canRecheckOcr(model) && typeof recheck?.mutate === "function";

  return (
    <div className="space-y-4">
      <VerdictBanner verdict={verdict} />

      {/* Root cause - the single sentence that answers "why?" */}
      {rootCause && (
        <div className="bg-white p-3 rounded border border-blue-200">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Root Cause</p>
          <p className="text-sm text-slate-800 mt-1">{rootCause}</p>
          {model.category && (
            <Badge className={`mt-2 ${STATE_CLASS[model.category === "TECHNICAL" ? "fail" : "warning"]}`}>
              {model.category}
            </Badge>
          )}
        </div>
      )}

      {/* Recheck */}
      {recheckAvailable && (
        <div className="bg-white p-3 rounded border border-blue-200 space-y-2">
          <Button
            variant="outline"
            size="sm"
            // Disabled while in flight, which is what prevents a double click
            // from launching two provider calls.
            disabled={recheck.isPending}
            onClick={() => {
              setRecheckError(null);
              recheck.mutate({ paymentId: payment.id });
            }}
          >
            {recheck.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden />
                Rechecking...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" aria-hidden />
                Recheck OCR
              </>
            )}
          </Button>
          <p className="text-xs text-slate-500">
            Re-runs OCR against the slip already on file. It never approves, never rejects, and
            never changes the payment status.
          </p>
          {recheckError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {recheckError}
            </p>
          )}
          {recheckResult?.readyForAdminApproval && (
            <p className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded p-2">
              Verification passed on recheck. Press <strong>Approve Manually</strong> to approve -
              this recheck did not approve anything by itself.
            </p>
          )}
        </div>
      )}

      {/* Legacy case ambiguity - an unanswered question, not a verdict */}
      {requiresLegacyCaseResolution(model) && (
        <div className="rounded-lg border-2 border-yellow-300 bg-yellow-50 p-4 space-y-3">
          <p className="text-sm font-bold text-yellow-900">⚠ Legacy Reference Case Ambiguity</p>
          <p className="text-sm text-yellow-900">
            This reference matches an older transaction only when letter casing is ignored.
            That older record lost its original casing, so <strong>this is not proof that the
            transaction is duplicated</strong> — the two references may be genuinely different.
          </p>
          {duplicate.matchedLabel && (
            <p className="text-sm text-yellow-900">
              <span className="font-semibold">Matched:</span>{" "}
              {duplicate.matchedHref ? (
                <a className="underline" href={duplicate.matchedHref}>
                  {duplicate.matchedLabel}
                </a>
              ) : (
                duplicate.matchedLabel
              )}
            </p>
          )}
          <p className="text-xs text-yellow-800">
            The normal Approve action cannot proceed here. Compare the amount, transaction time,
            bank and file-duplicate status above, then choose one:
          </p>

          <textarea
            className="w-full rounded border border-yellow-300 p-2 text-sm"
            rows={2}
            placeholder="Reason (required, min 10 characters) - permanently audited"
            value={resolutionReason}
            onChange={(e) => setResolutionReason(e.target.value)}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={resolveAmbiguity?.isPending || resolutionReason.trim().length < 10}
              onClick={() => {
                setResolutionError(null);
                resolveAmbiguity?.mutate?.({
                  paymentId: payment.id,
                  decision: "confirmed_duplicate",
                  reason: resolutionReason.trim(),
                });
              }}
            >
              Reject as Duplicate
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={resolveAmbiguity?.isPending || resolutionReason.trim().length < 10}
              onClick={() => {
                setResolutionError(null);
                resolveAmbiguity?.mutate?.({
                  paymentId: payment.id,
                  decision: "confirmed_distinct",
                  reason: resolutionReason.trim(),
                });
              }}
            >
              Approve as Distinct Transaction
            </Button>
          </div>

          {resolutionReason.trim().length > 0 && resolutionReason.trim().length < 10 && (
            <p className="text-xs text-yellow-800">A reason of at least 10 characters is required.</p>
          )}
          {resolutionError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {resolutionError}
            </p>
          )}
          {resolutionDone && (
            <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded p-2">
              {resolutionDone}
            </p>
          )}
        </div>
      )}

      {/* Verification checklist */}
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2">Verification Checklist</p>
        <div className="bg-white rounded border border-blue-200 divide-y divide-slate-100">
          {checklist.map((row) => (
            <div key={row.key} className="flex items-start gap-3 p-2.5">
              <StateIcon state={row.state} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-slate-800">{row.label}</span>
                  <Badge className={`text-[10px] ${STATE_CLASS[row.state]}`}>
                    {STATE_LABEL[row.state]}
                  </Badge>
                </div>
                {row.detail && (
                  <p className="text-xs text-slate-600 mt-0.5 break-words">{row.detail}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Amount */}
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2">Amount</p>
        <div className="grid grid-cols-2 gap-2 bg-white p-3 rounded border border-blue-200 text-sm">
          <div>
            <p className="text-slate-500 text-xs">Expected</p>
            <p className="font-semibold text-slate-900">
              {model.expectedAmount != null ? model.expectedAmount : "—"}
            </p>
          </div>
          <div>
            <p className="text-slate-500 text-xs">Extracted</p>
            <p className="font-semibold text-slate-900">{extracted?.amount ?? "—"}</p>
          </div>
        </div>
      </div>

      {/* Timing */}
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2">Transaction Timing</p>
        <div className="bg-white p-3 rounded border border-blue-200 text-sm space-y-1">
          <p className="text-slate-600">
            <span className="font-semibold">OCR transaction time:</span>{" "}
            {time.transactionAt ? time.transactionAt.toISOString() : "— (not readable)"}
          </p>
          <p className="text-slate-600">
            <span className="font-semibold">Slip submitted at:</span>{" "}
            {time.submittedAt ? time.submittedAt.toISOString() : "—"}
          </p>
          <p className="text-slate-600">
            <span className="font-semibold">Difference:</span>{" "}
            {time.differenceMinutes !== undefined ? `${time.differenceMinutes} min` : "—"}
          </p>
          <p className="text-slate-600">
            <span className="font-semibold">Allowed window:</span>{" "}
            {time.allowedWindowMinutes ? `${time.allowedWindowMinutes} min` : "—"}
          </p>
          {time.possibleMisreadWarning && (
            <p className="text-xs text-yellow-900 bg-yellow-50 border border-yellow-200 rounded p-2 mt-2">
              {time.possibleMisreadWarning}
            </p>
          )}
        </div>
      </div>

      {/* Reference */}
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2">Reference</p>
        <div className="bg-white p-3 rounded border border-blue-200 text-sm space-y-1">
          <p className="text-slate-600 break-all">
            <span className="font-semibold">Raw:</span> {referenceValue ?? "— (none found)"}
          </p>
          <p className="text-slate-600">
            <span className="font-semibold">Normalized:</span>{" "}
            {extracted?.referenceNormalized ? "yes" : referenceValue ? "not stored (legacy row)" : "—"}
          </p>
          <p className="text-slate-600">
            <span className="font-semibold">Used before:</span>{" "}
            {model.reviewReason === "DUPLICATE_REFERENCE" ? "YES" : "no"}
          </p>
        </div>
      </div>

      {/* Duplicate evidence */}
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2">Duplicate Evidence</p>
        <div className="bg-white p-3 rounded border border-blue-200 text-sm space-y-2">
          <div className="flex items-center gap-2">
            <Badge
              className={
                duplicate.strength === "strong"
                  ? "bg-red-100 text-red-800"
                  : duplicate.strength === "legacy_case_ambiguity"
                    ? "bg-yellow-100 text-yellow-900"
                  : duplicate.strength === "none"
                    ? "bg-slate-100 text-slate-600"
                    : "bg-yellow-100 text-yellow-800"
              }
            >
              {duplicate.strength === "legacy"
                ? "LEGACY / WEAK"
                : duplicate.strength === "legacy_case_ambiguity"
                  ? "LEGACY CASE AMBIGUITY"
                  : duplicate.strength.toUpperCase()}
            </Badge>
            <span className="text-slate-700">{duplicate.headline}</span>
          </div>
          {duplicate.caveat && (
            <p className="text-xs text-yellow-900 bg-yellow-50 border border-yellow-200 rounded p-2">
              {duplicate.caveat}
            </p>
          )}
          {duplicate.matchedLabel && (
            <p className="text-slate-600">
              <span className="font-semibold">Matched:</span>{" "}
              {duplicate.matchedHref ? (
                <a className="text-blue-700 underline" href={duplicate.matchedHref}>
                  {duplicate.matchedLabel}
                </a>
              ) : (
                duplicate.matchedLabel
              )}
            </p>
          )}
        </div>
      </div>

      {/* OCR attempt history - the real sequence, automatic runs included */}
      {Array.isArray(attemptsQuery?.data) && attemptsQuery.data.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-slate-700 mb-2">OCR Attempt History</p>
          <div className="bg-white rounded border border-blue-200 divide-y divide-slate-100">
            {attemptsQuery.data.map((a: any) => (
              <div key={`${a.attemptNo}-${a.startedAt}`} className="p-2.5 text-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-800">#{a.attemptNo}</span>
                  <Badge className="text-[10px] bg-slate-100 text-slate-700">
                    {String(a.trigger).replace(/_/g, " ")}
                  </Badge>
                  <Badge
                    className={`text-[10px] ${
                      a.result === "auto_approved"
                        ? "bg-green-100 text-green-800"
                        : a.result === "technical_failure"
                          ? "bg-red-100 text-red-800"
                          : "bg-yellow-100 text-yellow-800"
                    }`}
                  >
                    {String(a.result).replace(/_/g, " ")}
                  </Badge>
                  {a.reviewReason && (
                    <span className="text-xs text-slate-600">{a.reviewReason}</span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {a.startedAt ? new Date(a.startedAt).toLocaleString() : "—"}
                  {a.reviewCategory === "TECHNICAL" && a.providerHttpStatus
                    ? ` · HTTP ${a.providerHttpStatus} · ${a.providerAttemptCount} attempt(s)`
                    : ""}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Raw JSON - last, and never required to understand the outcome */}
      {extracted && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRawJson(!showRawJson)}
            className="text-xs"
          >
            {showRawJson ? "Hide" : "Show"} Raw JSON
          </Button>
          {showRawJson && (
            <pre className="mt-2 p-2 bg-slate-100 rounded text-xs overflow-auto max-h-48 border border-slate-300">
              {JSON.stringify(extracted, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
