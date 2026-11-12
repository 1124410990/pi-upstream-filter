export interface FilterStats {
  [key: string]: number;
}

export interface FilterResult {
  payload: unknown;
  stats: FilterStats;
}

export const FILTER_HOSTS: readonly string[];
export function matchesFilterEndpoint(baseUrl: unknown): boolean;

export function looksLikeResponsesPayload(payload: unknown): boolean;
export function looksLikeAnthropicPayload(payload: unknown): boolean;
export interface CompatibilityRejection {
  kind: "responses-resource" | "responses-id" | "responses-encrypted" | "anthropic-signature" | "anthropic-thinking";
  reasoning?: boolean;
  itemIds?: boolean;
  itemIndex?: number;
}

export function classifyCompatibilityError(
  errorMessage: unknown, payload: unknown, status?: number,
): CompatibilityRejection | undefined;
export function isTokenRateLimitError(message: unknown): boolean;
export function isTerminalLimitError(message: unknown): boolean;
export function filterResponsesPayload(
  payload: unknown, options?: Pick<CompatibilityRejection, "reasoning" | "itemIds" | "itemIndex">,
): FilterResult;
export function filterAnthropicPayload(payload: unknown): FilterResult;
