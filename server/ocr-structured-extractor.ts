/**
 * Structured OCR Extraction Layer
 * 
 * Provides bank-agnostic extraction of Thai bank slip data with normalized fields:
 * - bankName, senderName, senderAccountMasked
 * - receiverName, receiverAccountMasked, receiverBank
 * - amount, fee, netAmount
 * - transactionDateTime, referenceId, transactionId
 * - rawText, fieldConfidences, overallConfidence, transferType
 * 
 * Supports Thai/English labels, noisy OCR, masked accounts, Thai numerals, Buddhist years
 */

import { invokeLLM } from "./_core/llm";

export interface StructuredOCRData {
  // Bank info
  bankName: string | null;
  transferType: "QR" | "TRANSFER" | "PROMPTPAY" | "UNKNOWN";

  // Sender info
  senderName: string | null;
  senderAccountMasked: string | null;

  // Receiver info
  receiverName: string | null;
  receiverAccountMasked: string | null;
  receiverBank: string | null;

  // Amount info
  amount: number | null;
  fee: number | null;
  netAmount: number | null;

  // Transaction info
  transactionDateTime: Date | null;
  referenceId: string | null;
  transactionId: string | null;

  // Metadata
  rawText: string;
  fieldConfidences: Record<string, number>; // 0-100 per field
  overallConfidence: number; // 0-100
}

/**
 * Thai numeral to Arabic numeral conversion
 */
function convertThaiNumerals(text: string): string {
  const thaiNumerals = ["๐", "๑", "๒", "๓", "๔", "๕", "๖", "๗", "๘", "๙"];
  let result = text;
  thaiNumerals.forEach((thai, index) => {
    result = result.replace(new RegExp(thai, "g"), index.toString());
  });
  return result;
}

/**
 * Parse Thai Buddhist year to AD year
 */
function convertBuddhistYear(year: number): number {
  if (year > 2500) {
    return year - 543;
  }
  return year;
}

/**
 * Parse various datetime formats from OCR text
 */
function parseOCRDateTime(dateStr: string, timeStr?: string): Date | null {
  if (!dateStr) return null;

  // Convert Thai numerals
  dateStr = convertThaiNumerals(dateStr);
  if (timeStr) timeStr = convertThaiNumerals(timeStr);

  // Try various date formats
  const datePatterns = [
    /(\d{1,2})[\s\/\-](\d{1,2})[\s\/\-](\d{4})/,  // DD/MM/YYYY
    /(\d{4})[\s\/\-](\d{1,2})[\s\/\-](\d{1,2})/,  // YYYY/MM/DD
    /(\d{1,2})[\s\/\-](\d{1,2})[\s\/\-](\d{2})/,  // DD/MM/YY
  ];

  let day = 0, month = 0, year = 0;
  let matched = false;

  for (const pattern of datePatterns) {
    const match = dateStr.match(pattern);
    if (match) {
      if (match[3].length === 4) {
        // DD/MM/YYYY or YYYY/MM/DD
        if (parseInt(match[1]) > 31) {
          // YYYY/MM/DD
          year = parseInt(match[1]);
          month = parseInt(match[2]);
          day = parseInt(match[3]);
        } else {
          // DD/MM/YYYY
          day = parseInt(match[1]);
          month = parseInt(match[2]);
          year = parseInt(match[3]);
        }
      } else {
        // DD/MM/YY
        day = parseInt(match[1]);
        month = parseInt(match[2]);
        year = parseInt(match[3]);
        // Assume 20xx for 2-digit years
        if (year < 100) {
          year += 2000;
        }
      }

      // Convert Buddhist year if needed
      year = convertBuddhistYear(year);

      // Validate date
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        matched = true;
        break;
      }
    }
  }

  if (!matched) return null;

  // Parse time if provided
  let hours = 0, minutes = 0, seconds = 0;
  if (timeStr) {
    const timePattern = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;
    const timeMatch = timeStr.match(timePattern);
    if (timeMatch) {
      hours = parseInt(timeMatch[1]);
      minutes = parseInt(timeMatch[2]);
      seconds = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
    }
  }

  try {
    return new Date(year, month - 1, day, hours, minutes, seconds);
  } catch (e) {
    return null;
  }
}

/**
 * Extract masked account number (e.g., "XXXX-XXXX-1234")
 */
function extractMaskedAccount(text: string): string | null {
  // Look for patterns like XXXX-XXXX-1234 or ****-****-1234 or 1234 (last 4 digits)
  const patterns = [
    /[X\*]{4}[\s\-][X\*]{4}[\s\-](\d{4})/i,  // XXXX-XXXX-1234
    /(\d{4})(?:\s|$)/,  // Last 4 digits
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1] || match[0];
    }
  }

  return null;
}

/**
 * Detect bank from OCR text
 */
function detectBank(text: string): { bank: string; confidence: number } {
  const lowerText = text.toLowerCase();

  const bankPatterns = [
    { name: "KBANK", patterns: ["krung thai", "kbank", "kb\\d{9}"], confidence: 0.9 },
    { name: "SCB", patterns: ["siam commercial", "scb"], confidence: 0.9 },
    { name: "BBL", patterns: ["bangkok bank", "bbl"], confidence: 0.9 },
    { name: "KRUNGSRI", patterns: ["krungsri", "first choice"], confidence: 0.9 },
    { name: "PROMPTPAY", patterns: ["promptpay", "prompt pay"], confidence: 0.9 },
  ];

  for (const bank of bankPatterns) {
    for (const pattern of bank.patterns) {
      if (lowerText.includes(pattern)) {
        return { bank: bank.name, confidence: bank.confidence };
      }
    }
  }

  return { bank: "UNKNOWN", confidence: 0 };
}

/**
 * Detect transfer type from OCR text
 */
function detectTransferType(text: string): "QR" | "TRANSFER" | "PROMPTPAY" | "UNKNOWN" {
  const lowerText = text.toLowerCase();

  if (lowerText.includes("promptpay") || lowerText.includes("prompt pay")) {
    return "PROMPTPAY";
  }
  if (lowerText.includes("qr") || lowerText.includes("qr code")) {
    return "QR";
  }
  if (lowerText.includes("transfer") || lowerText.includes("โอน")) {
    return "TRANSFER";
  }

  return "UNKNOWN";
}

/**
 * Extract structured data from raw OCR text
 * Uses heuristics and pattern matching to normalize fields
 */
export function extractStructuredData(rawText: string): StructuredOCRData {
  const confidences: Record<string, number> = {};
  const data: StructuredOCRData = {
    bankName: null,
    transferType: "UNKNOWN",
    senderName: null,
    senderAccountMasked: null,
    receiverName: null,
    receiverAccountMasked: null,
    receiverBank: null,
    amount: null,
    fee: null,
    netAmount: null,
    transactionDateTime: null,
    referenceId: null,
    transactionId: null,
    rawText,
    fieldConfidences: confidences,
    overallConfidence: 0,
  };

  // Detect bank
  const bankDetection = detectBank(rawText);
  if (bankDetection.confidence > 0) {
    data.bankName = bankDetection.bank;
    confidences.bankName = bankDetection.confidence * 100;
  }

  // Detect transfer type
  data.transferType = detectTransferType(rawText);
  confidences.transferType = data.transferType !== "UNKNOWN" ? 80 : 0;

  // Extract sender name (look for "From:", "Sender:", "โอนจาก")
  const senderMatch = rawText.match(/(?:from|sender|โอนจาก)[:\s]+([^\n]+)/i);
  if (senderMatch) {
    data.senderName = senderMatch[1].trim();
    confidences.senderName = 75;
  }

  // Extract receiver name (look for "To:", "Receiver:", "โอนให้")
  const receiverMatch = rawText.match(/(?:to|receiver|โอนให้)[:\s]+([^\n]+)/i);
  if (receiverMatch) {
    data.receiverName = receiverMatch[1].trim();
    confidences.receiverName = 75;
  }

  // Extract amount (look for currency patterns)
  const amountMatch = rawText.match(/(?:amount|จำนวนเงิน|baht|บาท)[:\s]*([0-9,]+\.?[0-9]*)/i);
  if (amountMatch) {
    const amountStr = convertThaiNumerals(amountMatch[1]).replace(/,/g, "");
    const amount = parseFloat(amountStr);
    if (!isNaN(amount) && amount > 0) {
      data.amount = amount;
      confidences.amount = 85;
    }
  }

  // Extract fee if present
  const feeMatch = rawText.match(/(?:fee|ค่าธรรมเนียม)[:\s]*([0-9,]+\.?[0-9]*)/i);
  if (feeMatch) {
    const feeStr = convertThaiNumerals(feeMatch[1]).replace(/,/g, "");
    const fee = parseFloat(feeStr);
    if (!isNaN(fee) && fee >= 0) {
      data.fee = fee;
      confidences.fee = 75;
    }
  }

  // Extract net amount
  const netMatch = rawText.match(/(?:net|total|รวม)[:\s]*([0-9,]+\.?[0-9]*)/i);
  if (netMatch) {
    const netStr = convertThaiNumerals(netMatch[1]).replace(/,/g, "");
    const net = parseFloat(netStr);
    if (!isNaN(net) && net > 0) {
      data.netAmount = net;
      confidences.netAmount = 75;
    }
  }

  // Extract transaction date and time
  const dateMatch = rawText.match(/(?:date|วันที่)[:\s]*([0-9\/\-\s]+)/i);
  const timeMatch = rawText.match(/(?:time|เวลา)[:\s]*([0-9:]+)/i);
  if (dateMatch) {
    const dt = parseOCRDateTime(dateMatch[1], timeMatch?.[1]);
    if (dt) {
      data.transactionDateTime = dt;
      confidences.transactionDateTime = 80;
    }
  }

  // Extract reference ID
  const refMatch = rawText.match(/(?:reference|ref|เลขที่อ้างอิง)[:\s]*([A-Z0-9]+)/i);
  if (refMatch) {
    data.referenceId = refMatch[1].trim();
    confidences.referenceId = 80;
  }

  // Extract transaction ID
  const txMatch = rawText.match(/(?:transaction|tx|เลขที่ธุรกรรม)[:\s]*([A-Z0-9]+)/i);
  if (txMatch) {
    data.transactionId = txMatch[1].trim();
    confidences.transactionId = 80;
  }

  // Extract masked accounts
  const senderAcctMatch = rawText.match(/(?:from account|บัญชีโอน)[:\s]*([X\*\d\s\-]+)/i);
  if (senderAcctMatch) {
    data.senderAccountMasked = extractMaskedAccount(senderAcctMatch[1]) || senderAcctMatch[1].trim();
    confidences.senderAccountMasked = 70;
  }

  const receiverAcctMatch = rawText.match(/(?:to account|บัญชีรับ)[:\s]*([X\*\d\s\-]+)/i);
  if (receiverAcctMatch) {
    data.receiverAccountMasked = extractMaskedAccount(receiverAcctMatch[1]) || receiverAcctMatch[1].trim();
    confidences.receiverAccountMasked = 70;
  }

  // Calculate overall confidence (average of non-zero field confidences)
  const nonZeroConfidences = Object.values(confidences).filter((c) => c > 0);
  if (nonZeroConfidences.length > 0) {
    data.overallConfidence = Math.round(
      nonZeroConfidences.reduce((a, b) => a + b, 0) / nonZeroConfidences.length
    );
  }

  return data;
}

/**
 * Extract structured data from slip image/PDF using LLM
 */
export async function extractFromSlipImage(imageUrl: string): Promise<StructuredOCRData | null> {
  try {
    // First, extract raw text from image
    const isPDF = imageUrl.toLowerCase().endsWith(".pdf");
    const contentArray: any[] = [
      {
        type: "text",
        text: "Extract ALL text from this Thai bank slip. Return exactly what you see, preserving structure and labels.",
      },
    ];

    if (isPDF) {
      contentArray.push({
        type: "file_url",
        file_url: {
          url: imageUrl,
          mime_type: "application/pdf",
        },
      });
    } else {
      contentArray.push({
        type: "image_url",
        image_url: {
          url: imageUrl,
          detail: "high",
        },
      });
    }

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are an expert at extracting text from Thai bank slips. Extract ALL visible text exactly as shown.",
        },
        {
          role: "user",
          content: contentArray,
        },
      ],
    });

    const rawText = response.choices[0]?.message?.content;
    if (typeof rawText === "string") {
      return extractStructuredData(rawText);
    }

    return null;
  } catch (error) {
    console.error("Error extracting from slip image:", error);
    return null;
  }
}
