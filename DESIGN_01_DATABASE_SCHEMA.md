# Ipenovel V2 - Final Database Schema

## Overview

The database uses **18 tables** organized into logical domains: **Core**, **Content**, **Commerce**, **Features**, and **Admin**. All timestamps are stored as UTC milliseconds (Unix timestamps). The schema enforces data integrity through unique constraints, foreign keys, and check constraints.

---

## Core Domain

### `users` Table
Stores user accounts and authentication state.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Surrogate key for internal references |
| openId | VARCHAR(64) | UNIQUE, NOT NULL | Manus OAuth identifier |
| name | TEXT | NULLABLE | User display name |
| email | VARCHAR(320) | NULLABLE | User email address |
| loginMethod | VARCHAR(64) | NULLABLE | OAuth provider (e.g., "manus") |
| role | ENUM('user', 'admin') | NOT NULL, DEFAULT 'user' | Access level |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Account creation time |
| updatedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() ON UPDATE | Last profile update |
| lastSignedIn | TIMESTAMP | NOT NULL, DEFAULT NOW() | Last login time |

**Indexes:** `openId` (unique), `role`, `createdAt`

**Constraints:**
- One user per openId (enforced by unique constraint)
- Owner (from ENV.OWNER_OPEN_ID) automatically promoted to admin on first login

---

## Content Domain

### `categories` Table
Novel categories for organization and browsing.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Category ID |
| name | VARCHAR(100) | NOT NULL, UNIQUE | Category name (e.g., "Fantasy") |
| slug | VARCHAR(100) | NOT NULL, UNIQUE | URL-friendly slug |
| description | TEXT | NULLABLE | Category description |
| displayOrder | INT | DEFAULT 0 | Sort order for display |
| isActive | BOOLEAN | DEFAULT true | Visibility flag |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Creation time |

**Indexes:** `slug`, `displayOrder`, `isActive`

---

### `novels` Table
Novel metadata and general information.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Novel ID |
| title | VARCHAR(255) | NOT NULL | Novel title |
| slug | VARCHAR(255) | NOT NULL, UNIQUE | URL-friendly slug |
| description | TEXT | NULLABLE | Long description |
| author | VARCHAR(255) | NULLABLE | Author name |
| coverImageUrl | TEXT | NULLABLE | S3 URL to cover image |
| status | ENUM('ongoing', 'completed', 'hiatus') | DEFAULT 'ongoing' | Publication status |
| totalEpisodes | INT | DEFAULT 0 | Total episode count |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Creation time |
| updatedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() ON UPDATE | Last update time |

**Indexes:** `slug`, `status`, `createdAt`

**Constraints:**
- `totalEpisodes` auto-updated when episodes are added/removed
- Cover image must be S3 URL (enforced in application layer)

---

### `episodes` Table
Individual episodes/chapters of novels.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Episode ID |
| novelId | INT | NOT NULL, FOREIGN KEY | Reference to novels |
| episodeNumber | VARCHAR(50) | NOT NULL | Episode number or range (e.g., "1", "3-5") |
| title | VARCHAR(255) | NOT NULL | Episode title |
| description | TEXT | NULLABLE | Episode description |
| price | DECIMAL(10,2) | NOT NULL | Price in currency units (฿) |
| isFree | BOOLEAN | NOT NULL, DEFAULT false | Free/paid flag |
| fileUrl | TEXT | NULLABLE | S3 URL to episode file (PDF, EPUB, etc.) |
| fileKey | VARCHAR(255) | NULLABLE | S3 file key for deletion |
| viewCount | INT | DEFAULT 0 | Number of views |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Creation time |
| updatedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() ON UPDATE | Last update time |

**Indexes:** `novelId`, `episodeNumber`, `isFree`, `createdAt`

**Constraints:**
- Unique constraint on (novelId, episodeNumber) to prevent duplicate episodes
- `isFree = true` implies `price = 0.00`
- `fileUrl` must be S3 URL when present

---

### `novelCategories` Table
Many-to-many relationship between novels and categories.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Relationship ID |
| novelId | INT | NOT NULL, FOREIGN KEY | Reference to novels |
| categoryId | INT | NOT NULL, FOREIGN KEY | Reference to categories |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Creation time |

**Indexes:** Composite index on (novelId, categoryId)

**Constraints:**
- Unique constraint on (novelId, categoryId) to prevent duplicate assignments
- Supports multiple categories per novel

---

## Commerce Domain

### `carts` Table
Shopping cart sessions for users.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Cart ID |
| userId | INT | NOT NULL, FOREIGN KEY | Reference to users |
| sessionId | VARCHAR(64) | NOT NULL, UNIQUE | Session identifier for cart operations |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Cart creation time |
| updatedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() ON UPDATE | Last modification time |

**Indexes:** `userId`, `sessionId`

**Constraints:**
- One active cart per user (enforced in application layer)
- sessionId used for idempotency in cart operations

---

### `cartItems` Table
Individual items in shopping carts.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Item ID |
| cartId | INT | NOT NULL, FOREIGN KEY | Reference to carts |
| episodeId | INT | NOT NULL, FOREIGN KEY | Reference to episodes |
| quantity | INT | NOT NULL, DEFAULT 1 | Quantity (typically 1 per episode) |
| price | DECIMAL(10,2) | NOT NULL | Price at time of addition |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Addition time |

**Indexes:** `cartId`, `episodeId`

**Constraints:**
- Unique constraint on (cartId, episodeId) to prevent duplicate items in cart
- `quantity` >= 1
- `price` snapshot for historical tracking

---

### `orders` Table
Order headers containing billing and summary information.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Order ID |
| userId | INT | NULLABLE, FOREIGN KEY | Reference to users (nullable for test data) |
| orderNumber | VARCHAR(50) | NOT NULL, UNIQUE | Human-readable order identifier (e.g., "ORD-20260315-ABC123") |
| subtotalAmount | DECIMAL(10,2) | NOT NULL | Sum of item prices |
| discountAmount | DECIMAL(10,2) | DEFAULT 0 | Coupon discount applied |
| pointsRedeemed | INT | DEFAULT 0 | Points used for discount |
| pointsDiscount | DECIMAL(10,2) | DEFAULT 0 | Currency value of redeemed points |
| totalAmount | DECIMAL(10,2) | NOT NULL | Final amount to pay |
| status | ENUM('pending', 'approved', 'rejected') | DEFAULT 'pending' | Payment status |
| couponCode | VARCHAR(50) | NULLABLE | Applied coupon code |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Order creation time |
| updatedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() ON UPDATE | Last status update |

**Indexes:** `orderNumber` (unique), `userId`, `status`, `createdAt`

**Constraints:**
- `orderNumber` generated once and immutable
- `totalAmount = subtotalAmount - discountAmount - pointsDiscount`
- All amounts >= 0

---

### `orderItems` Table
Individual items within an order.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Item ID |
| orderId | INT | NOT NULL, FOREIGN KEY | Reference to orders |
| episodeId | INT | NOT NULL, FOREIGN KEY | Reference to episodes |
| originalPrice | DECIMAL(10,2) | NOT NULL | Episode price at purchase time |
| finalPrice | DECIMAL(10,2) | NOT NULL | Price after any discounts |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Addition time |

**Indexes:** `orderId`, `episodeId`

**Constraints:**
- `finalPrice <= originalPrice`
- All prices >= 0

---

### `payments` Table
Payment records and admin review state.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Payment ID |
| orderId | INT | NOT NULL, UNIQUE, FOREIGN KEY | Reference to orders (one payment per order) |
| status | ENUM('pending', 'approved', 'rejected') | DEFAULT 'pending' | Admin review status |
| slipImageUrl | TEXT | NULLABLE | S3 URL to payment slip image |
| slipImageKey | VARCHAR(255) | NULLABLE | S3 file key for deletion |
| rejectionReason | TEXT | NULLABLE | Reason for rejection (if rejected) |
| approvedAt | TIMESTAMP | NULLABLE | Approval timestamp |
| approvedBy | INT | NULLABLE, FOREIGN KEY | Admin user ID who approved |
| rejectedAt | TIMESTAMP | NULLABLE | Rejection timestamp |
| rejectedBy | INT | NULLABLE, FOREIGN KEY | Admin user ID who rejected |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Payment record creation time |
| updatedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() ON UPDATE | Last status update |

**Indexes:** `orderId` (unique), `status`, `createdAt`

**Constraints:**
- One payment per order (enforced by unique constraint)
- `approvedAt` and `approvedBy` both set or both null
- `rejectedAt` and `rejectedBy` both set or both null
- `rejectionReason` only set when status = 'rejected'

---

### `purchases` Table
**SOURCE OF TRUTH FOR ACCESS CONTROL** - Entitlements granted to users.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Purchase ID |
| userId | INT | NOT NULL, FOREIGN KEY | Reference to users |
| episodeId | INT | NOT NULL, FOREIGN KEY | Reference to episodes |
| orderId | INT | NOT NULL, FOREIGN KEY | Reference to orders |
| purchaseType | ENUM('paid', 'free') | NOT NULL | How the episode was acquired |
| grantedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | When access was granted |
| expiresAt | TIMESTAMP | NULLABLE | Optional expiration time |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Record creation time |

**Indexes:** Composite index on (userId, episodeId), `userId`, `episodeId`, `orderId`

**Constraints:**
- **Unique constraint on (userId, episodeId)** - Prevents duplicate purchases (idempotency)
- `purchaseType = 'free'` only for free episodes
- `expiresAt` null means permanent access

---

## Features Domain

### `coupons` Table
Discount codes for promotional campaigns.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Coupon ID |
| code | VARCHAR(50) | NOT NULL, UNIQUE | Coupon code (e.g., "SUMMER30") |
| discountType | ENUM('flat', 'percentage') | NOT NULL | Discount calculation type |
| discountValue | DECIMAL(10,2) | NOT NULL | Discount amount or percentage |
| minPurchaseAmount | DECIMAL(10,2) | DEFAULT 0 | Minimum order total to apply |
| maxUsageCount | INT | NULLABLE | Max total uses (null = unlimited) |
| usageCount | INT | DEFAULT 0 | Current usage count |
| isActive | BOOLEAN | DEFAULT true | Availability flag |
| expiresAt | TIMESTAMP | NULLABLE | Expiration date (null = no expiration) |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Creation time |
| updatedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() ON UPDATE | Last update time |

**Indexes:** `code` (unique), `isActive`, `expiresAt`

**Constraints:**
- `discountValue > 0`
- `maxUsageCount` null or > 0
- `usageCount <= maxUsageCount` (if maxUsageCount is set)

---

### `couponUsages` Table
Track which users have used which coupons (for per-user limits if needed).

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Usage ID |
| couponId | INT | NOT NULL, FOREIGN KEY | Reference to coupons |
| orderId | INT | NOT NULL, FOREIGN KEY | Reference to orders |
| userId | INT | NOT NULL, FOREIGN KEY | Reference to users |
| usedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Usage time |

**Indexes:** Composite index on (couponId, userId), `orderId`

**Constraints:**
- Tracks per-user coupon usage for analytics and potential per-user limits

---

### `pointsTransactions` Table
Points earning and redemption history.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Transaction ID |
| userId | INT | NOT NULL, FOREIGN KEY | Reference to users |
| orderId | INT | NULLABLE, FOREIGN KEY | Reference to orders (if order-related) |
| transactionType | ENUM('earn', 'redeem', 'admin') | NOT NULL | Type of transaction |
| pointsAmount | INT | NOT NULL | Points gained or spent |
| description | VARCHAR(255) | NULLABLE | Human-readable description |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Transaction time |

**Indexes:** `userId`, `orderId`, `transactionType`, `createdAt`

**Constraints:**
- `pointsAmount > 0`
- Conversion: 100 currency units = 1 point (earn), 1 point = 1 currency (redeem)

---

### `wishlists` Table
User wishlist items for future purchases.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Wishlist item ID |
| userId | INT | NOT NULL, FOREIGN KEY | Reference to users |
| episodeId | INT | NOT NULL, FOREIGN KEY | Reference to episodes |
| addedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Addition time |

**Indexes:** Composite index on (userId, episodeId), `userId`

**Constraints:**
- Unique constraint on (userId, episodeId) to prevent duplicate wishlist items

---

## Admin Domain

### `banners` Table
Promotional banners displayed on the home page.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Banner ID |
| title | VARCHAR(255) | NOT NULL | Banner title |
| description | TEXT | NULLABLE | Banner description |
| imageUrl | TEXT | NOT NULL | S3 URL to banner image |
| linkUrl | VARCHAR(500) | NULLABLE | Link target URL |
| displayOrder | INT | DEFAULT 0 | Display priority |
| isActive | BOOLEAN | DEFAULT true | Visibility flag |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Creation time |
| updatedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() ON UPDATE | Last update time |

**Indexes:** `displayOrder`, `isActive`, `createdAt`

**Constraints:**
- `imageUrl` must be S3 URL

---

### `settings` Table
Site-wide configuration and settings.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Setting ID |
| key | VARCHAR(100) | NOT NULL, UNIQUE | Setting key (e.g., "discord_webhook_url") |
| value | TEXT | NOT NULL | Setting value |
| description | TEXT | NULLABLE | Setting description |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Creation time |
| updatedAt | TIMESTAMP | NOT NULL, DEFAULT NOW() ON UPDATE | Last update time |

**Indexes:** `key` (unique)

**Constraints:**
- Key-value store for admin configuration
- Examples: `discord_webhook_url`, `site_name`, `support_email`

---

### `orderHistory` Table
Audit log for order status changes and admin actions.

| Column | Type | Constraints | Notes |
|--------|------|-----------|-------|
| id | INT | PRIMARY KEY, AUTO_INCREMENT | Log ID |
| orderId | INT | NOT NULL, FOREIGN KEY | Reference to orders |
| action | VARCHAR(50) | NOT NULL | Action performed (e.g., "created", "approved", "rejected") |
| performedBy | INT | NULLABLE, FOREIGN KEY | Admin user ID (null for system actions) |
| details | TEXT | NULLABLE | Additional context (JSON) |
| createdAt | TIMESTAMP | NOT NULL, DEFAULT NOW() | Action time |

**Indexes:** `orderId`, `action`, `createdAt`

**Constraints:**
- Immutable audit trail for compliance and debugging

---

## Summary Statistics

| Aspect | Count | Notes |
|--------|-------|-------|
| **Total Tables** | 18 | Organized into 5 domains |
| **Primary Keys** | 18 | All tables have surrogate keys |
| **Foreign Keys** | ~25 | Enforce referential integrity |
| **Unique Constraints** | 15+ | Prevent duplicates and enforce business rules |
| **Indexes** | 40+ | Optimize query performance |

---

## Key Design Decisions

1. **Surrogate Keys:** All tables use auto-increment INT primary keys for performance and flexibility
2. **Timestamps:** All timestamps stored as TIMESTAMP (UTC) for consistency
3. **Soft Deletes:** Not used; records are either active or inactive via boolean flags
4. **Idempotency:** Unique constraints on (userId, episodeId) in purchases prevent duplicate grants
5. **Audit Trail:** orderHistory table provides complete audit log of order lifecycle
6. **S3 Integration:** All file URLs stored in database; actual files in S3 with pre-signed URLs
7. **Nullable Foreign Keys:** orders.userId nullable to support test data without user accounts
8. **Enum Types:** Used for status fields to enforce valid values at database level
9. **Check Constraints:** Applied to ensure data integrity (e.g., amounts >= 0)

---

## Migration Strategy

1. Create all tables in order: Core → Content → Commerce → Features → Admin
2. Create indexes after table creation
3. Add foreign key constraints after all tables exist
4. Seed test data in order: categories → novels → episodes → banners → coupons

---

## Future Extensibility

- **Series/Collections:** Add table to group related novels
- **Reviews & Ratings:** Add reviews table with user ratings
- **Reading Progress:** Add reading_progress table to track user progress
- **Subscriptions:** Add subscription plans and user subscriptions
- **Notifications:** Add notifications table for user alerts
- **Analytics:** Add events table for user behavior tracking
