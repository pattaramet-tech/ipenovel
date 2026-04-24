-- Seed admin account
-- Email: admin@ipenovel.com
-- Password: Ipe@novel2026 (hashed with bcrypt)
INSERT INTO users (openId, name, email, loginMethod, passwordHash, role, createdAt, updatedAt, lastSignedIn) 
VALUES ('admin-ipenovel', 'Admin', 'admin@ipenovel.com', 'local', '$2a$10$N9qo8uLOickgx2ZMRZoMye.hCvAn6VxC1dKLVgGvvEaFLfOWvCnFm', 'admin', NOW(), NOW(), NOW())
ON DUPLICATE KEY UPDATE role = 'admin';
