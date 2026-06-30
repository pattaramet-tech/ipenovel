/**
 * Migration: Fix walletTopups schema to match Drizzle definition
 *
 * This migration adds missing columns to walletTopups table in production
 * Required because production DB was missing OCR-related columns
 *
 * Before running:
 * 1. SHOW COLUMNS FROM walletTopups;
 * 2. Check which columns are missing
 * 3. Run only the ALTER statements for missing columns
 * 4. Do NOT run ADD COLUMN if column exists (will cause error)
 */

-- Check current state (run this first, don't run as part of migration)
-- SHOW CREATE TABLE walletTopups;
-- SHOW COLUMNS FROM walletTopups;

-- ============================================
-- Fix existing columns that might have wrong defaults
-- ============================================

-- Ensure status has correct enum values and default
ALTER TABLE walletTopups
  MODIFY status ENUM('pending','pending_review','approved','rejected','cancelled') NOT NULL DEFAULT 'pending';

-- Ensure timestamps have correct defaults
ALTER TABLE walletTopups
  MODIFY createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Ensure slipSubmittedAt is nullable
ALTER TABLE walletTopups
  MODIFY slipSubmittedAt TIMESTAMP NULL DEFAULT NULL;

-- Ensure approvalSource has correct enum values
ALTER TABLE walletTopups
  MODIFY approvalSource ENUM('manual','ocr_auto') NULL DEFAULT 'manual';

-- Ensure ocrDecision has correct enum values
ALTER TABLE walletTopups
  MODIFY ocrDecision ENUM('approved','needs_review','rejected') NULL DEFAULT NULL;

-- ============================================
-- Add missing columns (one per ALTER statement)
-- If you get "Duplicate column name" error, the column exists - skip that statement
-- ============================================

-- Add approvedAt if missing
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS approvedAt TIMESTAMP NULL DEFAULT NULL;

-- Add approvedByAdminId if missing
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS approvedByAdminId INT NULL;

-- Add rejectedAt if missing
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS rejectedAt TIMESTAMP NULL DEFAULT NULL;

-- Add extractedData if missing (for OCR extracted data)
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS extractedData TEXT NULL;

-- Add ocrConfidence if missing
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS ocrConfidence DECIMAL(5,2) NULL;

-- Add visionConfidence if missing
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS visionConfidence DECIMAL(5,2) NULL;

-- Add structuredConfidence if missing
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS structuredConfidence DECIMAL(5,2) NULL;

-- Add finalConfidence if missing
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS finalConfidence DECIMAL(5,2) NULL;

-- Add duplicateStatus if missing (for duplicate detection result)
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS duplicateStatus TEXT NULL;

-- Add ocrDecision if missing (enum for OCR decision)
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS ocrDecision ENUM('approved','needs_review','rejected') NULL DEFAULT NULL;

-- Add reviewReason if missing (why admin/OCR rejected or flagged)
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS reviewReason TEXT NULL;

-- Add approvalSource if missing (track if manual or OCR auto approval)
ALTER TABLE walletTopups ADD COLUMN IF NOT EXISTS approvalSource ENUM('manual','ocr_auto') NULL DEFAULT 'manual';

-- ============================================
-- Add indexes if missing (for performance)
-- ============================================

-- Check if indexes exist before adding
-- ALTER TABLE walletTopups ADD INDEX IF NOT EXISTS walletTopups_userId_idx (userId);
-- ALTER TABLE walletTopups ADD INDEX IF NOT EXISTS walletTopups_status_idx (status);
-- ALTER TABLE walletTopups ADD INDEX IF NOT EXISTS walletTopups_createdAt_idx (createdAt);

-- Verify migration
-- SELECT COUNT(*) as total_rows FROM walletTopups;
-- SHOW COLUMNS FROM walletTopups;
