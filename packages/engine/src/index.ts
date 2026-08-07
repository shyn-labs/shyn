export { openDatabase, EMBEDDING_DIM } from "./storage.js";
export { isPlumbingUri, canonicalUri, stripScreenFurniture, metaHeader } from "./hygiene.js";
export { StaticKeyProvider, KeychainKeyProvider, type KeyProvider } from "./keys.js";
export { shynHome } from "./paths.js";
export { chunkFor, type Source } from "./chunk.js";
export { ingestDocument } from "./ingest.js";
export { keywordSearch } from "./search-keyword.js";
export { search } from "./search.js";
export type { IngestDoc, Hit, SearchQuery, SearchResult } from "./types.js";
export {
  Embedder, LlamaBackend, ModelNotReadyError, EmbedBackendUnavailableError, quantizeInt8, QUERY_PREFIX, type EmbedBackend,
} from "./embedder.js";
export { drainEmbedQueue } from "./embed-worker.js";
export { ensureModel, MODEL_FILE } from "./model-download.js";
export { forget, type ForgetSelector } from "./forget.js";
export { sweepScreenRetention, sweepMeetingRetention } from "./retention.js";
export {
  recordBeat, coverageReport, sweepCoverage,
  HEARTBEAT_SECONDS, GAP_FACTOR,
  type CoverageGap, type CoverageReport,
} from "./coverage.js";
export { Engine, type EngineStatus, type SyncResult } from "./engine.js";
export { bumpCounter, sumCounters, dayKey } from "./counters.js";
export { getStats, type StatsResult } from "./stats.js";
export type { Reader, ReaderAvailability } from "./readers/types.js";
export { getWatermark, setWatermark, DEFAULT_BACKFILL_SECONDS } from "./readers/watermark.js";
export { webkitToUnix, macToUnix } from "./readers/epoch.js";
export { ChromeHistoryReader } from "./readers/chrome.js";
export { SafariHistoryReader } from "./readers/safari.js";
export { NotesReader } from "./readers/notes.js";
export { extractLongestString } from "./readers/protobuf-text.js";
export { copyAndOpen } from "./readers/sqlite-copy.js";
