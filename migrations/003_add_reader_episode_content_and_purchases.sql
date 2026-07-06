-- Add content and metadata fields to episodes table
ALTER TABLE episodes
ADD COLUMN content LONGTEXT NULL AFTER description,
ADD COLUMN contentFormat VARCHAR(50) DEFAULT 'plain_text' AFTER content,
ADD COLUMN isPublished BOOLEAN DEFAULT TRUE NOT NULL AFTER contentFormat,
ADD COLUMN publishedAt TIMESTAMP NULL AFTER isPublished,
ADD COLUMN wordCount INT NULL AFTER publishedAt,
ADD COLUMN sortOrder INT NULL AFTER wordCount;

-- Create episodePurchases table for wallet-based episode purchases
CREATE TABLE IF NOT EXISTS episodePurchases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  novelId INT NOT NULL,
  episodeId INT NOT NULL,
  pricePaid DECIMAL(10, 2) NOT NULL,
  walletTransactionId INT,
  purchasedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,

  INDEX idx_userId (userId),
  INDEX idx_novelId (novelId),
  INDEX idx_episodeId (episodeId),
  INDEX idx_walletTransactionId (walletTransactionId),
  UNIQUE KEY unique_user_episode_purchase (userId, episodeId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create readingProgress table for tracking user progress
CREATE TABLE IF NOT EXISTS readingProgress (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  novelId INT NOT NULL,
  episodeId INT NOT NULL,
  progressPercent INT DEFAULT 0 NOT NULL,
  scrollPosition INT DEFAULT 0 NOT NULL,
  lastReadAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL,

  INDEX idx_userId (userId),
  INDEX idx_novelId (novelId),
  INDEX idx_episodeId (episodeId),
  UNIQUE KEY unique_user_episode_progress (userId, episodeId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
