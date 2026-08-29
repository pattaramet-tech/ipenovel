export type SportsRewardKind = "coupon" | "points";
export type SportsDiscountType = "flat" | "percentage";

export interface SportsTeamLookup {
  id: number;
  code: string;
  name: string;
  logoImageUrl?: string | null;
  isActive?: boolean;
}

export interface SportsRewardConfigInput {
  rewardKind?: SportsRewardKind;
  rewardPointsAmount?: string | null;
  rewardDiscountType?: SportsDiscountType | null;
  rewardDiscountValue?: string | null;
  rewardMinPurchaseAmount?: string | null;
  rewardCouponExpiresAt?: Date | null;
}

export interface NormalizedSportsRewardConfig {
  rewardKind: SportsRewardKind;
  rewardPointsAmount: string | null;
  rewardDiscountType: SportsDiscountType | null;
  rewardDiscountValue: string | null;
  rewardMinPurchaseAmount: string | null;
  rewardCouponExpiresAt: Date | null;
}

export class SportsVoteValidationError extends Error {
  readonly code:
    | "UNKNOWN_TEAM"
    | "AMBIGUOUS_TEAM"
    | "NON_MEMBER_TEAM"
    | "INACTIVE_TEAM"
    | "INVALID_REWARD"
    | "INVALID_CODE";

  constructor(code: SportsVoteValidationError["code"], message: string) {
    super(message);
    this.name = "SportsVoteValidationError";
    this.code = code;
  }
}

export function normalizeSportsCatalogCode(value: string, fieldName = "code"): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(normalized)) {
    throw new SportsVoteValidationError(
      "INVALID_CODE",
      `${fieldName} must use 1-80 characters: A-Z, 0-9, underscore, or hyphen`
    );
  }
  return normalized;
}

export function normalizeSportsTeamName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function parseDecimal(
  value: string | null | undefined,
  fieldName: string,
  options: { positive?: boolean } = {}
): number {
  const raw = value == null ? "" : String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new SportsVoteValidationError("INVALID_REWARD", `${fieldName} must be a decimal number`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || (options.positive && parsed <= 0)) {
    throw new SportsVoteValidationError(
      "INVALID_REWARD",
      `${fieldName} must be ${options.positive ? "> 0" : ">= 0"}`
    );
  }
  return parsed;
}

function moneyString(value: number): string {
  return value.toFixed(2);
}

export function validateSportsRewardConfig(input: SportsRewardConfigInput): NormalizedSportsRewardConfig {
  const rewardKind = input.rewardKind ?? "coupon";

  if (rewardKind === "points") {
    const points = parseDecimal(input.rewardPointsAmount, "rewardPointsAmount", { positive: true });
    return {
      rewardKind,
      rewardPointsAmount: moneyString(points),
      rewardDiscountType: null,
      rewardDiscountValue: null,
      rewardMinPurchaseAmount: null,
      rewardCouponExpiresAt: null,
    };
  }

  if (input.rewardDiscountType !== "flat" && input.rewardDiscountType !== "percentage") {
    throw new SportsVoteValidationError(
      "INVALID_REWARD",
      "rewardDiscountType is required for coupon rewards"
    );
  }
  const discountValue = parseDecimal(input.rewardDiscountValue, "rewardDiscountValue", { positive: true });
  if (input.rewardDiscountType === "percentage" && discountValue > 100) {
    throw new SportsVoteValidationError(
      "INVALID_REWARD",
      "rewardDiscountValue cannot exceed 100 for percentage coupon rewards"
    );
  }
  const minPurchase = parseDecimal(input.rewardMinPurchaseAmount ?? "0", "rewardMinPurchaseAmount");
  if (input.rewardCouponExpiresAt && input.rewardCouponExpiresAt.getTime() <= Date.now()) {
    throw new SportsVoteValidationError(
      "INVALID_REWARD",
      "rewardCouponExpiresAt must be in the future"
    );
  }

  return {
    rewardKind,
    rewardPointsAmount: null,
    rewardDiscountType: input.rewardDiscountType,
    rewardDiscountValue: moneyString(discountValue),
    rewardMinPurchaseAmount: moneyString(minPurchase),
    rewardCouponExpiresAt: input.rewardCouponExpiresAt ?? null,
  };
}

export function buildSportsMatchCatalogView(
  match: Record<string, any>,
  competition?: { code?: string | null; name?: string | null; competitionType?: string | null },
  homeTeam?: SportsTeamLookup,
  awayTeam?: SportsTeamLookup
): Record<string, any> {
  return {
    ...match,
    competitionCode: competition?.code ?? null,
    competitionName: competition?.name ?? match.leagueName ?? null,
    competitionType: competition?.competitionType ?? null,
    leagueName: competition?.name ?? match.leagueName,
    homeTeamName: homeTeam?.name ?? match.homeTeamName,
    awayTeamName: awayTeam?.name ?? match.awayTeamName,
    homeTeamImageUrl: homeTeam?.logoImageUrl ?? match.homeTeamImageUrl,
    awayTeamImageUrl: awayTeam?.logoImageUrl ?? match.awayTeamImageUrl,
  };
}

export function resolveSportsTeamReference(
  reference: string | number,
  competitionTeams: SportsTeamLookup[],
  allTeams: SportsTeamLookup[]
): SportsTeamLookup {
  const raw = String(reference).trim();
  if (!raw) {
    throw new SportsVoteValidationError("UNKNOWN_TEAM", "Team reference is required");
  }

  const memberIds = new Set(competitionTeams.map((team) => team.id));
  const assertMember = (team: SportsTeamLookup): SportsTeamLookup => {
    if (!memberIds.has(team.id)) {
      throw new SportsVoteValidationError(
        "NON_MEMBER_TEAM",
        `Team ${team.code || team.name} exists but is not a member of the selected competition`
      );
    }
    if (team.isActive === false) {
      throw new SportsVoteValidationError(
        "INACTIVE_TEAM",
        `Team ${team.code || team.name} is inactive`
      );
    }
    return competitionTeams.find((candidate) => candidate.id === team.id) ?? team;
  };

  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    const team = allTeams.find((candidate) => candidate.id === id);
    if (!team) throw new SportsVoteValidationError("UNKNOWN_TEAM", `Unknown team id ${raw}`);
    return assertMember(team);
  }

  const normalizedCode = raw.toUpperCase();
  const codeMatches = allTeams.filter((candidate) => candidate.code.toUpperCase() === normalizedCode);
  if (codeMatches.length === 1) return assertMember(codeMatches[0]);
  if (codeMatches.length > 1) {
    throw new SportsVoteValidationError("AMBIGUOUS_TEAM", `Ambiguous team code ${raw}`);
  }

  const normalizedName = normalizeSportsTeamName(raw);
  const memberNameMatches = competitionTeams.filter(
    (candidate) => normalizeSportsTeamName(candidate.name) === normalizedName
  );
  if (memberNameMatches.length === 1) {
    if (memberNameMatches[0].isActive === false) {
      throw new SportsVoteValidationError("INACTIVE_TEAM", `Team ${raw} is inactive`);
    }
    return memberNameMatches[0];
  }
  if (memberNameMatches.length > 1) {
    throw new SportsVoteValidationError(
      "AMBIGUOUS_TEAM",
      `Ambiguous team name ${raw}; use the stable team code or id`
    );
  }

  const globalNameMatches = allTeams.filter(
    (candidate) => normalizeSportsTeamName(candidate.name) === normalizedName
  );
  if (globalNameMatches.length === 1) return assertMember(globalNameMatches[0]);
  if (globalNameMatches.length > 1) {
    throw new SportsVoteValidationError(
      "AMBIGUOUS_TEAM",
      `Ambiguous team name ${raw}; use the stable team code or id`
    );
  }

  throw new SportsVoteValidationError("UNKNOWN_TEAM", `Unknown team reference ${raw}`);
}
