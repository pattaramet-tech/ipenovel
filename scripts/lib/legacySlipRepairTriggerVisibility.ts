/** Only accepts server output from literal SHOW GRANTS (the CURRENT account).
 * Do not accept caller-supplied grants or issue SHOW GRANTS FOR another user.
 * Grant text may contain authentication hashes; it must NEVER be logged.
 * Roles, table/column grants and database wildcards deliberately fail closed. */
export function hasRepairTriggerVisibility(rows: unknown): boolean {
  if (!Array.isArray(rows) || !rows.length || rows.length > 256) return false;
  const grants: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const values = Object.values(row);
    if (
      values.length !== 1 ||
      typeof values[0] !== "string" ||
      values[0].length > 32768 ||
      /[\x00-\x1f\x7f]/.test(values[0])
    )
      return false;
    grants.push(values[0]);
  }
  // Parse all of the scope and quoted principal before ignoring a server's
  // authentication/REQUIRE/resource suffix, which does not change the grant.
  const account = "(?:`(?:[^`]|``)+`|'(?:[^'\\\\]|\\\\.|'')+')";
  const pattern = new RegExp(
    "^GRANT ([A-Z_]+(?: [A-Z_]+)*(?:, ?[A-Z_]+(?: [A-Z_]+)*)*) ON (?:\\*\\.\\*|`ipenovel`\\.\\*) TO " +
      account +
      "@" +
      account +
      "(?: |$)"
  );
  return grants.some(grant => {
    const match = pattern.exec(grant);
    return (
      match?.[1]
        .split(",")
        .map(part => part.trim())
        .some(
          privilege => privilege === "TRIGGER" || privilege === "ALL PRIVILEGES"
        ) ?? false
    );
  });
}
