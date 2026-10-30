/** Explicit selection is produced by a separate bounded metadata survey, never guessed by the downloader. */
export type ProjectedBounds = [number, number, number, number];
export interface AcquisitionSource {
  id: string; title: string; url: string; license: string; licenseUrl: string; attribution: string;
  crs: string; heightDatum: string; units: string; axisOrder: string;
}
export interface CachedSource {root: string; path: string; bytes: number; sha256: string}
export interface SelectedPayload {
  file: string; url: string; bytes?: number; sha256?: string; cache?: CachedSource;
  transform?: number[]; geometricError?: number; z?: number; x?: number; y?: number;
}
export interface AcquisitionPartition {id: string; bboxEN: ProjectedBounds}
interface LayerBase {id: string; source: AcquisitionSource; vintage: string}
export interface TiledAcquisitionLayer extends LayerBase {
  kind: 'tiles'; indexMetadata: Record<string, unknown>; tiles: SelectedPayload[]; metadata?: SelectedPayload[];
}
export interface WfsAcquisitionLayer extends LayerBase {
  kind: 'wfs'; typeName: string; stableKey: string; maxFeatures: number; partitions: AcquisitionPartition[];
  accepted?: CachedSource;
}
export interface OsmAcquisitionLayer extends LayerBase {
  kind: 'osm'; partitions: AcquisitionPartition[]; maxClosureRequests: number; accepted?: CachedSource;
}
export type AcquisitionLayer = TiledAcquisitionLayer | WfsAcquisitionLayer | OsmAcquisitionLayer;
export interface AcquisitionJob {
  schemaVersion: 1; snapshot: string; bboxEN: ProjectedBounds;
  budgetBytes: number; maxPayloadBytes: number; timeoutMs?: number; retries?: number; concurrency?: number;
  layers: AcquisitionLayer[];
}

/** An explicit consumer-scope amendment leaves the original acquisition job and all raw parts immutable. */
export interface OsmClosureReview {
  schemaVersion: 1; kind: 'reviewed-osm-consumer-closure'; sourceJobSha256: string; baseProgressSha256: string;
  layer: string; maxAdditionalClosureRequests: number; supersedesReviewSha256?: string;
  consumers: {file: string; sha256: string}[];
  excludedRelations: {id: number; sourceSha256: string; type: string; reason: string}[];
}
