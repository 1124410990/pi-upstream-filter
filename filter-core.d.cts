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
export function filterResponsesPayload(payload: unknown): FilterResult;
export function filterAnthropicPayload(payload: unknown): FilterResult;
