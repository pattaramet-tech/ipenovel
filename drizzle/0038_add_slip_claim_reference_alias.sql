ALTER TABLE `paymentSlipClaims` ADD `referenceHashUpper` varchar(64);--> statement-breakpoint
CREATE INDEX `paymentSlipClaims_referenceHashUpper_idx` ON `paymentSlipClaims` (`referenceHashUpper`);