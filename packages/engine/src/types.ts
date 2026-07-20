import type { Source } from "./chunk.js";

export type IngestDoc = {
  source: Source; uri: string; title: string; ts: number;
  text: string; meta?: Record<string, unknown>;
};
export type Hit = {
  docId: number; chunkId: number; source: string; uri: string;
  title: string; ts: number; text: string; score: number;
};
export type SearchQuery = {
  query: string; timeFrom?: number; timeTo?: number;
  sources?: string[]; limit?: number;
};
export type SearchResult = { mode: "hybrid" | "keyword-only"; hits: Hit[] };
