/**
 * Migration: Fix walletAccounts schema to ensure correct defaults
 *
 * This migration ensures walletAccounts columns have proper constraints and defaults
 */

-- Check current state (run this first)
-- SHOW CREATE TABLE walletAccounts;
-- SHOW COLUMNS FROM walletAccounts;

-- ============================================
-- Fix decimal fields to have proper defaults
-- ============================================

ALTER TABLE walletAccounts
  MODIFY balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  MODIFY totalTopupApproved DECIMAL(12,2) NULL DEFAULT 0.00,
  MODIFY totalSpent DECIMAL(12,2) NULL DEFAULT 0.00;

-- ============================================
-- Fix timestamp fields
-- ============================================

ALTER TABLE walletAccounts
  MODIFY createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- ============================================
-- Verify migration
-- ============================================

-- SELECT COUNT(*) as total_accounts FROM walletAccounts;
-- SHOW COLUMNS FROM walletAccounts;
