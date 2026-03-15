CREATE TABLE `banners` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`imageUrl` text NOT NULL,
	`linkUrl` text,
	`displayOrder` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `banners_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cartItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cartId` int NOT NULL,
	`episodeId` int NOT NULL,
	`novelId` int NOT NULL,
	`price` decimal(10,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cartItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_cart_episode` UNIQUE(`cartId`,`episodeId`)
);
--> statement-breakpoint
CREATE TABLE `carts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `carts_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_user_cart` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`description` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `categories_name_unique` UNIQUE(`name`),
	CONSTRAINT `categories_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `couponUsages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`couponId` int NOT NULL,
	`userId` int,
	`orderId` int NOT NULL,
	`usedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `couponUsages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `coupons` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(50) NOT NULL,
	`discountType` enum('flat','percentage') NOT NULL,
	`discountValue` decimal(10,2) NOT NULL,
	`minPurchaseAmount` decimal(10,2) DEFAULT '0.00',
	`maxUsageCount` int,
	`usageCount` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`expiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `coupons_id` PRIMARY KEY(`id`),
	CONSTRAINT `coupons_code_unique` UNIQUE(`code`),
	CONSTRAINT `coupons_code_idx` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`novelId` int NOT NULL,
	`episodeNumber` varchar(100) NOT NULL,
	`title` varchar(500) NOT NULL,
	`description` text,
	`isFree` boolean NOT NULL DEFAULT false,
	`price` decimal(10,2) NOT NULL DEFAULT '0.00',
	`fileUrl` text,
	`fileSize` int,
	`fileMimeType` varchar(100),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `episodes_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_novel_episode` UNIQUE(`novelId`,`episodeNumber`)
);
--> statement-breakpoint
CREATE TABLE `novelCategories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`novelId` int NOT NULL,
	`categoryId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `novelCategories_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_novel_category` UNIQUE(`novelId`,`categoryId`)
);
--> statement-breakpoint
CREATE TABLE `novels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(500) NOT NULL,
	`slug` varchar(500) NOT NULL,
	`description` text,
	`author` varchar(255),
	`coverImageUrl` text,
	`status` enum('ongoing','completed','hiatus') NOT NULL DEFAULT 'ongoing',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `novels_id` PRIMARY KEY(`id`),
	CONSTRAINT `novels_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `orderHistory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderId` int NOT NULL,
	`action` varchar(100) NOT NULL,
	`fromStatus` varchar(50),
	`toStatus` varchar(50),
	`actorUserId` int,
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `orderHistory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orderItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderId` int NOT NULL,
	`novelId` int NOT NULL,
	`episodeId` int NOT NULL,
	`unitPrice` decimal(10,2) NOT NULL,
	`discountAmount` decimal(10,2) NOT NULL DEFAULT '0.00',
	`finalPrice` decimal(10,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `orderItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_order_episode` UNIQUE(`orderId`,`episodeId`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderNumber` varchar(50) NOT NULL,
	`userId` int,
	`subtotal` decimal(12,2) NOT NULL DEFAULT '0.00',
	`discountAmount` decimal(12,2) NOT NULL DEFAULT '0.00',
	`pointsDiscountAmount` decimal(12,2) NOT NULL DEFAULT '0.00',
	`totalAmount` decimal(12,2) NOT NULL DEFAULT '0.00',
	`status` enum('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
	`paymentStatus` enum('unpaid','submitted','approved','rejected') NOT NULL DEFAULT 'unpaid',
	`couponCodeSnapshot` varchar(100),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_orderNumber_unique` UNIQUE(`orderNumber`),
	CONSTRAINT `orders_orderNumber_idx` UNIQUE(`orderNumber`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderId` int NOT NULL,
	`slipImageUrl` text,
	`slipSubmittedAt` timestamp,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`rejectionReason` text,
	`reviewedByUserId` int,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_orderId_unique` UNIQUE(`orderId`),
	CONSTRAINT `payments_orderId_idx` UNIQUE(`orderId`)
);
--> statement-breakpoint
CREATE TABLE `pointsTransactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`type` enum('earn','redeem','adjust','refund') NOT NULL,
	`amount` decimal(10,2) NOT NULL,
	`balanceAfter` decimal(10,2) NOT NULL,
	`referenceType` varchar(50),
	`referenceId` int,
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pointsTransactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`novelId` int NOT NULL,
	`episodeId` int NOT NULL,
	`orderId` int NOT NULL,
	`grantedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `purchases_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_user_episode` UNIQUE(`userId`,`episodeId`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`key` varchar(255) NOT NULL,
	`value` text,
	`description` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `settings_key_unique` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `wishlists` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`novelId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `wishlists_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_user_novel` UNIQUE(`userId`,`novelId`)
);
--> statement-breakpoint
CREATE INDEX `cartItems_cartId_idx` ON `cartItems` (`cartId`);--> statement-breakpoint
CREATE INDEX `cartItems_episodeId_idx` ON `cartItems` (`episodeId`);--> statement-breakpoint
CREATE INDEX `carts_userId_idx` ON `carts` (`userId`);--> statement-breakpoint
CREATE INDEX `couponUsages_couponId_idx` ON `couponUsages` (`couponId`);--> statement-breakpoint
CREATE INDEX `couponUsages_userId_idx` ON `couponUsages` (`userId`);--> statement-breakpoint
CREATE INDEX `couponUsages_orderId_idx` ON `couponUsages` (`orderId`);--> statement-breakpoint
CREATE INDEX `episodes_novelId_idx` ON `episodes` (`novelId`);--> statement-breakpoint
CREATE INDEX `novelId_idx` ON `novelCategories` (`novelId`);--> statement-breakpoint
CREATE INDEX `categoryId_idx` ON `novelCategories` (`categoryId`);--> statement-breakpoint
CREATE INDEX `orderHistory_orderId_idx` ON `orderHistory` (`orderId`);--> statement-breakpoint
CREATE INDEX `orderHistory_actorUserId_idx` ON `orderHistory` (`actorUserId`);--> statement-breakpoint
CREATE INDEX `orderItems_orderId_idx` ON `orderItems` (`orderId`);--> statement-breakpoint
CREATE INDEX `orderItems_episodeId_idx` ON `orderItems` (`episodeId`);--> statement-breakpoint
CREATE INDEX `orders_userId_idx` ON `orders` (`userId`);--> statement-breakpoint
CREATE INDEX `payments_reviewedByUserId_idx` ON `payments` (`reviewedByUserId`);--> statement-breakpoint
CREATE INDEX `pointsTransactions_userId_idx` ON `pointsTransactions` (`userId`);--> statement-breakpoint
CREATE INDEX `pointsTransactions_referenceType_referenceId_idx` ON `pointsTransactions` (`referenceType`,`referenceId`);--> statement-breakpoint
CREATE INDEX `purchases_userId_idx` ON `purchases` (`userId`);--> statement-breakpoint
CREATE INDEX `purchases_episodeId_idx` ON `purchases` (`episodeId`);--> statement-breakpoint
CREATE INDEX `purchases_orderId_idx` ON `purchases` (`orderId`);--> statement-breakpoint
CREATE INDEX `wishlists_userId_idx` ON `wishlists` (`userId`);--> statement-breakpoint
CREATE INDEX `wishlists_novelId_idx` ON `wishlists` (`novelId`);