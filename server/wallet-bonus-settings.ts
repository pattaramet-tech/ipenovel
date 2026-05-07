/**
 * Wallet Top-up Bonus Settings Service
 * 
 * Manages editable bonus rules for wallet top-ups.
 * Stores rules as JSON in the settings table (key: wallet_topup_bonus_rules).
 */

import { getDb } from "./db";
import { settings } from "../drizzle/schema";
import { eq } from "drizzle-orm";

export interface BonusRule {
  id: string; // UUID for rule identification
  threshold: number; // Minimum top-up amount to qualify
  bonus: number; // Bonus amount to award
  enabled: boolean; // Whether this rule is active
  label?: string; // Optional promotion label
  createdAt: Date;
  updatedAt: Date;
}

export interface BonusRulesSettings {
  rules: BonusRule[];
  lastUpdated: Date;
}

const SETTINGS_KEY = "wallet_topup_bonus_rules";

// Default rules if none exist
const DEFAULT_RULES: BonusRule[] = [
  {
    id: "default-250",
    threshold: 250,
    bonus: 10,
    enabled: true,
    label: "Standard bonus",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "default-500",
    threshold: 500,
    bonus: 20,
    enabled: true,
    label: "Premium bonus",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

/**
 * Get all bonus rules from settings
 * Returns default rules if none exist
 */
export async function getBonusRules(): Promise<BonusRule[]> {
  const db = await getDb();
  if (!db) {
    console.warn("[Wallet Bonus] Database not available, using defaults");
    return DEFAULT_RULES;
  }

  try {
    const result = await db
      .select()
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .limit(1);

    if (result.length === 0) {
      // First time: initialize with defaults
      await initializeBonusRules();
      return DEFAULT_RULES;
    }

    const stored = JSON.parse(result[0].value || "{}") as BonusRulesSettings;
    return stored.rules || DEFAULT_RULES;
  } catch (error) {
    console.error("[Wallet Bonus] Error fetching bonus rules:", error);
    return DEFAULT_RULES;
  }
}

/**
 * Get only enabled bonus rules, sorted by threshold (ascending)
 */
export async function getEnabledBonusRules(): Promise<BonusRule[]> {
  const rules = await getBonusRules();
  return rules.filter((r) => r.enabled).sort((a, b) => a.threshold - b.threshold);
}

/**
 * Calculate bonus based on current settings
 * Uses highest matching enabled rule
 */
export async function calculateBonusFromSettings(
  requestedAmount: string | number
): Promise<string> {
  const amount =
    typeof requestedAmount === "string"
      ? parseFloat(requestedAmount)
      : requestedAmount;

  if (isNaN(amount) || amount <= 0) {
    throw new Error("Invalid amount: must be a positive number");
  }

  const enabledRules = await getEnabledBonusRules();

  if (enabledRules.length === 0) {
    // No rules enabled: no bonus
    return "0.00";
  }

  // Find the highest matching rule
  let matchingBonus = 0;
  for (const rule of enabledRules) {
    if (amount >= rule.threshold) {
      matchingBonus = rule.bonus;
    } else {
      // Rules are sorted by threshold, so we can stop here
      break;
    }
  }

  return matchingBonus.toFixed(2);
}

/**
 * Initialize bonus rules with defaults (called on first use)
 */
export async function initializeBonusRules(): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const settingsData: BonusRulesSettings = {
    rules: DEFAULT_RULES,
    lastUpdated: new Date(),
  };

  try {
    await db
      .insert(settings)
      .values({
        key: SETTINGS_KEY,
        value: JSON.stringify(settingsData),
        description: "Wallet top-up bonus rules for promotions",
      })
      .onDuplicateKeyUpdate({
        set: {
          value: JSON.stringify(settingsData),
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error("[Wallet Bonus] Error initializing bonus rules:", error);
    throw error;
  }
}

/**
 * Update bonus rules (admin only)
 */
export async function updateBonusRules(newRules: BonusRule[]): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  // Validate rules
  validateBonusRules(newRules);

  // Sort by threshold for consistent ordering
  const sortedRules = newRules.sort((a, b) => a.threshold - b.threshold);

  const settingsData: BonusRulesSettings = {
    rules: sortedRules,
    lastUpdated: new Date(),
  };

  try {
    await db
      .insert(settings)
      .values({
        key: SETTINGS_KEY,
        value: JSON.stringify(settingsData),
        description: "Wallet top-up bonus rules for promotions",
      })
      .onDuplicateKeyUpdate({
        set: {
          value: JSON.stringify(settingsData),
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error("[Wallet Bonus] Error updating bonus rules:", error);
    throw error;
  }
}

/**
 * Add a new bonus rule
 */
export async function addBonusRule(
  threshold: number,
  bonus: number,
  label?: string
): Promise<void> {
  const rules = await getBonusRules();

  // Check for duplicate threshold
  if (rules.some((r) => r.threshold === threshold)) {
    throw new Error(`Rule for threshold ${threshold} already exists`);
  }

  const newRule: BonusRule = {
    id: `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    threshold,
    bonus,
    enabled: true,
    label,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  rules.push(newRule);
  await updateBonusRules(rules);
}

/**
 * Update an existing bonus rule
 */
export async function updateBonusRule(
  ruleId: string,
  updates: Partial<BonusRule>
): Promise<void> {
  const rules = await getBonusRules();
  const ruleIndex = rules.findIndex((r) => r.id === ruleId);

  if (ruleIndex === -1) {
    throw new Error(`Rule with id ${ruleId} not found`);
  }

  const updatedRule = {
    ...rules[ruleIndex],
    ...updates,
    id: rules[ruleIndex].id, // Don't allow changing ID
    createdAt: rules[ruleIndex].createdAt, // Don't allow changing creation date
    updatedAt: new Date(),
  };

  // Check for duplicate threshold if threshold is being changed
  if (
    updates.threshold !== undefined &&
    updates.threshold !== rules[ruleIndex].threshold
  ) {
    if (rules.some((r) => r.id !== ruleId && r.threshold === updates.threshold)) {
      throw new Error(`Rule for threshold ${updates.threshold} already exists`);
    }
  }

  rules[ruleIndex] = updatedRule;
  await updateBonusRules(rules);
}

/**
 * Delete a bonus rule
 */
export async function deleteBonusRule(ruleId: string): Promise<void> {
  const rules = await getBonusRules();
  const filteredRules = rules.filter((r) => r.id !== ruleId);

  if (filteredRules.length === rules.length) {
    throw new Error(`Rule with id ${ruleId} not found`);
  }

  await updateBonusRules(filteredRules);
}

/**
 * Enable/disable a bonus rule
 */
export async function toggleBonusRule(
  ruleId: string,
  enabled: boolean
): Promise<void> {
  await updateBonusRule(ruleId, { enabled });
}

/**
 * Validate bonus rules
 */
function validateBonusRules(rules: BonusRule[]): void {
  if (!Array.isArray(rules)) {
    throw new Error("Rules must be an array");
  }

  const thresholds = new Set<number>();

  for (const rule of rules) {
    // Validate threshold
    if (typeof rule.threshold !== "number" || rule.threshold <= 0) {
      throw new Error("Each rule must have a positive threshold");
    }

    // Check for duplicate thresholds
    if (thresholds.has(rule.threshold)) {
      throw new Error(`Duplicate threshold: ${rule.threshold}`);
    }
    thresholds.add(rule.threshold);

    // Validate bonus
    if (typeof rule.bonus !== "number" || rule.bonus < 0) {
      throw new Error("Each rule must have a non-negative bonus");
    }

    // Validate enabled
    if (typeof rule.enabled !== "boolean") {
      throw new Error("Each rule must have an enabled boolean");
    }
  }
}

/**
 * Reset bonus rules to defaults (admin only, for testing)
 */
export async function resetBonusRulesToDefaults(): Promise<void> {
  await updateBonusRules(DEFAULT_RULES);
}
