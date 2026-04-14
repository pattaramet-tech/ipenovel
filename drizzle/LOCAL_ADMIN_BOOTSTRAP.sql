-- ⚠️  LOCAL/DEV-ONLY MIGRATION
-- This migration creates a local admin account for development and testing.
-- It is automatically skipped in production deployments.
--
-- This migration is only applied when NODE_ENV=development
-- Production deployments use: NODE_ENV=production node apply-migrations.mjs
--
-- Local admin account credentials:
-- Email: admin@ipenovel.com
-- Password: Ipe@novel2026 (hashed with bcrypt)
-- OpenID: admin-ipenovel
--
-- ⚠️  SECURITY: Change this password after first login in local development

INSERT INTO users (openId, name, email, loginMethod, passwordHash, role, createdAt, updatedAt, lastSignedIn) 
VALUES ('admin-ipenovel', 'Admin', 'admin@ipenovel.com', 'local', '$2a$10$N9qo8uLOickgx2ZMRZoMye.hCvAn6VxC1dKLVgGvvEaFLfOWvCnFm', 'admin', NOW(), NOW(), NOW())
ON DUPLICATE KEY UPDATE role = 'admin';
