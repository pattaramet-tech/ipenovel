/**
 * Wallet Top-up Bonus Service
 * Manages dynamic bonus configuration and calculations
 */

import * as db from "../db";

export interface BonusTier {
  minAmount: number;
  bonusAmount: number;
  label: string;
}

export interface BonusConfig {
  enabled: boolean;
  tiers: BonusTier[];
}

export interface BonusCalculation {
  requestedAmount: number;
  bonusAmount: number;
  creditedAmount: number;
  matchedTier: BonusTier | null;
  nextTier: {
    minAmount: number;
    bonusAmount: number;
    amountNeeded: number;
    extraBonus: number;
  } | null;
}

/**
 * Default bonus configuration
 * Used when config is not found or parsing fails
 */
const DEFAULT_BONUS_CONFIG: BonusConfig = {
  enabled: true,
  tiers: [
    {
      minAmount: 250,
      bonusAmount: 10,
      label: "เติมครบ 250 รับโบนัส 10",
    },
    {
      minAmount: 500,
      bonusAmount: 20,
      label: "เติมครบ 500 รับโบนัส 20",
    },
  ],
};

/**
 * Get wallet top-up bonus configuration
 * Fetches from settings or returns default if missing
 */
export async function getWalletBonusConfig(): Promise<BonusConfig> {
  try {
    const setting = await db.getSetting("wallet_topup_bonus_config");
    if (!setting?.value) {
      return DEFAULT_BONUS_CONFIG;
    }

    const config = JSON.parse(setting.value) as BonusConfig;

    // Validate config structure
    if (!Array.isArray(config.tiers)) {
      return DEFAULT_BONUS_CONFIG;
    }

    // Sort tiers by minAmount
    config.tiers.sort((a, b) => a.minAmount - b.minAmount);

    return config;
  } catch (error) {
    console.warn("[Wallet Bonus] Failed to load config, using default", error);
    return DEFAULT_BONUS_CONFIG;
  }
}

/**
 * Validate bonus configuration
 * Returns null if valid, or error message if invalid
 */
export function validateBonusConfig(config: BonusConfig): string | null {
  if (!Array.isArray(config.tiers)) {
    return "Tiers must be an array";
  }

  if (config.tiers.length === 0 && config.enabled) {
    return "At least one tier is required when bonus is enabled";
  }

  const seenAmounts = new Set<number>();
  for (const tier of config.tiers) {
    if (tier.minAmount <= 0) {
      return `Min amount must be greater than 0, got ${tier.minAmount}`;
    }
    if (tier.bonusAmount < 0) {
      return `Bonus amount cannot be negative, got ${tier.bonusAmount}`;
    }
    if (seenAmounts.has(tier.minAmount)) {
      return `Duplicate min amount: ${tier.minAmount}`;
    }
    seenAmounts.add(tier.minAmount);
  }

  return null;
}

/**
 * Calculate bonus and credited amount for a top-up
 * Returns detailed breakdown including matched tier and next tier info
 */
export async function calculateWalletTopupBonus(
  requestedAmount: string | number
): Promise<BonusCalculation> {
  const config = await getWalletBonusConfig();
  const amount = typeof requestedAmount === "string"
    ? parseFloat(requestedAmount)
    : requestedAmount;

  // Validate amount
  if (isNaN(amount) || amount <= 0) {
    return {
      requestedAmount: amount,
      bonusAmount: 0,
      creditedAmount: amount,
      matchedTier: null,
      nextTier: null,
    };
  }

  if (!config.enabled) {
    return {
      requestedAmount: amount,
      bonusAmount: 0,
      creditedAmount: amount,
      matchedTier: null,
      nextTier: null,
    };
  }

  // Find matched tier (highest minAmount that amount >= minAmount)
  let matchedTier: BonusTier | null = null;
  for (const tier of config.tiers) {
    if (amount >= tier.minAmount) {
      matchedTier = tier;
    } else {
      break; // Since tiers are sorted, no need to check further
    }
  }

  const bonusAmount = matchedTier?.bonusAmount ?? 0;
  const creditedAmount = amount + bonusAmount;

  // Find next tier
  let nextTier = null;
  if (matchedTier) {
    const nextTierObj = config.tiers.find((t) => t.minAmount > matchedTier!.minAmount);
    if (nextTierObj) {
      const amountNeeded = nextTierObj.minAmount - amount;
      const extraBonus = nextTierObj.bonusAmount - bonusAmount;
      nextTier = {
        minAmount: nextTierObj.minAmount,
        bonusAmount: nextTierObj.bonusAmount,
        amountNeeded,
        extraBonus,
      };
    }
  } else {
    // No matched tier, find first tier
    const firstTier = config.tiers[0];
    if (firstTier) {
      const amountNeeded = firstTier.minAmount - amount;
      nextTier = {
        minAmount: firstTier.minAmount,
        bonusAmount: firstTier.bonusAmount,
        amountNeeded,
        extraBonus: firstTier.bonusAmount,
      };
    }
  }

  return {
    requestedAmount: amount,
    bonusAmount: Math.round(bonusAmount * 100) / 100,
    creditedAmount: Math.round(creditedAmount * 100) / 100,
    matchedTier,
    nextTier,
  };
}

/**
 * Get bonus preview for UI display
 * Same as calculateWalletTopupBonus but optimized for preview
 */
export async function getWalletTopupBonusPreview(
  requestedAmount: string | number
): Promise<BonusCalculation> {
  return calculateWalletTopupBonus(requestedAmount);
}

/**
 * Save bonus configuration to settings
 * Admin-only operation
 */
export async function saveWalletBonusConfig(config: BonusConfig): Promise<void> {
  const error = validateBonusConfig(config);
  if (error) {
    throw new Error(`Invalid bonus config: ${error}`);
  }

  // Sort tiers before saving
  const sortedConfig = {
    ...config,
    tiers: [...config.tiers].sort((a, b) => a.minAmount - b.minAmount),
  };

  await db.setSetting("wallet_topup_bonus_config", JSON.stringify(sortedConfig));
}

/**
 * Get default bonus config
 */
export function getDefaultBonusConfig(): BonusConfig {
  return DEFAULT_BONUS_CONFIG;
}
