/** Type declarations for safeErrorSummary.mjs - the shared, build-step-free error sanitizer. */

/** Redacts connection strings, credentials, hosts and IPs from free text. */
export declare function redactSensitiveText(text: unknown): string;

/** Reduces one error message to a short, safe fragment, or null if nothing safe survives. */
export declare function sanitizeErrorMessage(raw: unknown): string | null;

/** A short, log-safe one-line summary of an error: code/errno/sqlState plus a sanitized underlying message. */
export declare function safeErrorSummary(error: unknown): string;
