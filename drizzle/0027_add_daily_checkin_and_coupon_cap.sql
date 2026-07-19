CREATE TABLE `dailyCheckins` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`checkinDate` varchar(10) NOT NULL,
	`campaignKey` varchar(50) NOT NULL DEFAULT 'default',
	`couponId` int NOT NULL,
	`status` enum('issued','used','void') NOT NULL DEFAULT 'issued',
	`issuedAt` timestamp NOT NULL DEFAULT (now()),
	`usedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailyCheckins_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_daily_checkin_user_date_campaign` UNIQUE(`userId`,`checkinDate`,`campaignKey`),
	CONSTRAINT `unique_daily_checkins_coupon` UNIQUE(`couponId`)
);
--> statement-breakpoint
ALTER TABLE `coupons` ADD `maxDiscountAmount` decimal(10,2);--> statement-breakpoint
CREATE INDEX `dailyCheckins_userId_idx` ON `dailyCheckins` (`userId`);