import type { ModelId } from "./types.js";
export interface OnlineRating {
    score: number;
    source: string;
    url?: string;
    rank?: number;
    note?: string;
    updatedAt: string;
}
export interface OnlineRatings {
    updatedAt: string;
    source: string;
    models: Record<ModelId, OnlineRating>;
}
export declare const DEFAULT_ONLINE_RATINGS: OnlineRatings;
export declare function loadOnlineRatings(dataDir: string): Promise<OnlineRatings>;
export declare function saveOnlineRatings(dataDir: string, ratings: OnlineRatings): Promise<void>;
export declare function onlineRatingFor(model: ModelId, ratings: OnlineRatings): OnlineRating | undefined;
/**
 * Quality-first ordering. Rated models always precede unrated ones. Online
 * score and rank are the only quality signals; speed is not a ranking input.
 */
export declare function rankModelsByOnline(models: ModelId[], online: OnlineRatings): ModelId[];
export declare function parseBenchlmRows(html: string): OnlineRatings["models"];
export declare function refreshOnlineRatings(options: {
    dataDir: string;
    url?: string;
    timeoutMs?: number;
}): Promise<OnlineRatings>;
