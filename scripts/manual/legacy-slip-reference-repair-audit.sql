-- MANUAL FUTURE LIVE PREREQUISITE ONLY. NOT a Drizzle migration.
-- Never execute during deployment, app startup, prepare, attestation or dry-run.
-- Requires a separate DBA approval/change window; this implementation run does
-- not authorize executing this DDL or any payment update.
-- Review exact database target, backups and table privileges before execution.
-- Intentionally no IF NOT EXISTS: incompatible pre-existing schema must fail.
CREATE TABLE legacySlipReferenceRepairAudit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sourceType VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sourceId BIGINT UNSIGNED NOT NULL,
  intentSha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operationId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  planSha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  planRunId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  targetFingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operatorAttestationSha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  secondReviewSha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  authorizationSha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  beforeSnapshot LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  afterSnapshot LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  createdAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_legacy_repair_source (sourceType, sourceId),
  UNIQUE KEY uq_legacy_repair_intent (intentSha256),
  UNIQUE KEY uq_legacy_repair_operation (operationId),
  CONSTRAINT ck_legacy_repair_scope CHECK (sourceType = 'order_payment' AND sourceId = 11280001),
  CONSTRAINT ck_legacy_repair_before_json CHECK (JSON_VALID(beforeSnapshot)),
  CONSTRAINT ck_legacy_repair_after_json CHECK (JSON_VALID(afterSnapshot))
) ENGINE=InnoDB COMMENT='legacy-slip-reference-repair-audit/v1';
