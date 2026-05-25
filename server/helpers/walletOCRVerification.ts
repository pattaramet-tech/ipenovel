/**
 * Wallet OCR Verification Helper
 * Handles OCR verification for wallet top-up slips
 * Ensures amount in slip matches requested top-up amount
 */

import { normalizeMoneyAmount, formatMoney, moneyEquals } from "./moneyNormalizer";

export interface WalletOCRContext {
  topupId: number;
  userId: number;
  requestedAmount: string; // The amount user requested to top-up
  slipImageUrl: string;
  isPdf: boolean; // true if slip is PDF, false if JPG/PNG
}

export interface WalletVerificationResult {
  isValid: boolean;
  reason: string; // Reason for validation result
  extractedAmount?: number; // Amount extracted from slip (if successful)
  shouldAutoApprove: boolean; // true only if JPG/PNG AND amount matches
  requiresManualReview: boolean; // true if PDF OR amount mismatch OR extraction failed
}

/**
 * Verify wallet top-up slip amount against requested amount
 * 
 * Rules:
 * 1. PDF files → always manual review (cannot auto-approve)
 * 2. JPG/PNG with matching amount → can auto-approve
 * 3. JPG/PNG with mismatched amount → manual review
 * 4. JPG/PNG with extraction failure → manual review
 */
export function verifyWalletTopupSlip(context: WalletOCRContext, extractedAmount?: number): WalletVerificationResult {
  // Normalize requested amount
  let normalizedRequested: number;
  try {
    normalizedRequested = normalizeMoneyAmount(context.requestedAmount, "requestedAmount");
  } catch (e) {
    return {
      isValid: false,
      reason: `Invalid requested amount: ${String(context.requestedAmount)}`,
      shouldAutoApprove: false,
      requiresManualReview: true,
    };
  }

  // Rule 1: PDF files always require manual review
  if (context.isPdf) {
    return {
      isValid: true,
      reason: "PDF slip - requires manual review (cannot auto-approve)",
      extractedAmount: extractedAmount,
      shouldAutoApprove: false,
      requiresManualReview: true,
    };
  }

  // Rule 2: If no extracted amount, cannot verify
  if (extractedAmount === undefined || extractedAmount === null) {
    return {
      isValid: false,
      reason: "Could not extract amount from slip image",
      shouldAutoApprove: false,
      requiresManualReview: true,
    };
  }

  // Normalize extracted amount
  let normalizedExtracted: number;
  try {
    normalizedExtracted = normalizeMoneyAmount(extractedAmount, "extractedAmount");
  } catch (e) {
    return {
      isValid: false,
      reason: `Invalid extracted amount: ${String(extractedAmount)}`,
      extractedAmount: extractedAmount,
      shouldAutoApprove: false,
      requiresManualReview: true,
    };
  }

  // Rule 3: Check if amounts match (with 0.01 tolerance for floating point)
  const amountsMatch = moneyEquals(normalizedExtracted, normalizedRequested, 0.01);

  if (!amountsMatch) {
    return {
      isValid: false,
      reason: `Amount mismatch: slip shows ${formatMoney(normalizedExtracted, "extracted")}, but requested ${formatMoney(normalizedRequested, "requested")}`,
      extractedAmount: normalizedExtracted,
      shouldAutoApprove: false,
      requiresManualReview: true,
    };
  }

  // Rule 4: JPG/PNG with matching amount → can auto-approve
  return {
    isValid: true,
    reason: `Amount verified: ${formatMoney(normalizedExtracted, "amount")} matches requested amount`,
    extractedAmount: normalizedExtracted,
    shouldAutoApprove: true,
    requiresManualReview: false,
  };
}

/**
 * Check if a slip file is PDF based on URL or MIME type
 */
export function isPdfSlip(slipImageUrl: string): boolean {
  if (!slipImageUrl) return false;
  
  const urlLower = slipImageUrl.toLowerCase();
  
  // Check URL extension
  if (urlLower.endsWith(".pdf")) return true;
  
  // Check MIME type in URL (if present)
  if (urlLower.includes("application/pdf")) return true;
  if (urlLower.includes("mime=pdf")) return true;
  
  // Default to false (assume JPG/PNG)
  return false;
}
