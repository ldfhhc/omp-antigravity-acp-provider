// OMP may replace the oldest image blocks with a fixed omission marker after
// its five-image budget. Capture immutable per-record digests so a later prefix
// can be recognized as that one-way eviction only. Callers snapshot each
// accepted pending context and match that prefix; this helper never retains
// message objects or image bytes and never consults a global ledger.
import { types } from "node:util";

const OMISSION_TEXT = "[image omitted: provider image limit]";
const OMISSION = Object.freeze({ type: "text", text: OMISSION_TEXT });

export interface ImageHistoryCheckpoint {
  readonly records: readonly ImageHistoryRecord[];
}

interface ImageHistoryRecord {
  readonly digest: string;
  readonly images?: ImageSlots;
}

interface ImageSlots {
  readonly positions: readonly number[];
  readonly digests: readonly string[];
  readonly projected: string;
}

export function captureImageHistoryCheckpoint<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  fingerprint: (message: T) => string,
): ImageHistoryCheckpoint | undefined {
  const records: ImageHistoryRecord[] = [];
  let hasImages = false;
  for (const message of messages) {
    if (message.role === "system") continue;
    const digest = fingerprint(message);
    const images = snapshotImages(message, fingerprint);
    if (images) hasImages = true;
    records.push(images ? { digest, images } : { digest });
  }
  return hasImages ? { records } : undefined;
}

export function matchesImageHistoryCheckpoint<T extends { role: string; content: unknown }>(
  checkpoint: ImageHistoryCheckpoint | undefined,
  messages: readonly T[],
  fingerprint: (message: T) => string,
): boolean {
  if (!checkpoint) return false;
  const candidates: T[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    candidates.push(message);
  }
  if (candidates.length !== checkpoint.records.length) return false;
  let evicted = false;
  for (let i = 0; i < candidates.length; i++) {
    const record = checkpoint.records[i]!;
    const message = candidates[i]!;
    if (fingerprint(message) === record.digest) continue;
    if (!record.images || !isImageEviction(record.images, message, fingerprint)) return false;
    evicted = true;
  }
  return evicted;
}

function snapshotImages<T extends { role: string; content: unknown }>(
  message: T,
  fingerprint: (message: T) => string,
): ImageSlots | undefined {
  const content = message.content;
  if (!isDenseArray(content)) return undefined;
  const positions: number[] = [];
  const digests: string[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = dataValue(content, i);
    if (ownData(block, "type") !== "image") continue;
    positions.push(i);
    digests.push(fingerprint({ ...message, content: [block] } as T));
  }
  if (positions.length === 0) return undefined;
  return { positions, digests, projected: fingerprint(omitImages(message, content, positions)) };
}

function isImageEviction<T extends { role: string; content: unknown }>(
  images: ImageSlots,
  message: T,
  fingerprint: (message: T) => string,
): boolean {
  const content = message.content;
  if (!isDenseArray(content)) return false;
  let sawMarker = false;
  for (let i = 0; i < images.positions.length; i++) {
    const index = images.positions[i]!;
    if (index >= content.length) return false;
    const block = dataValue(content, index);
    if (isExactMarker(block)) {
      sawMarker = true;
      continue;
    }
    if (ownData(block, "type") !== "image" || fingerprint({ ...message, content: [block] } as T) !== images.digests[i]) {
      return false;
    }
  }
  return sawMarker && fingerprint(omitImages(message, content, images.positions)) === images.projected;
}

function omitImages<T extends { role: string; content: unknown }>(
  message: T,
  content: readonly unknown[],
  positions: readonly number[],
): T {
  const next = content.slice();
  for (const index of positions) next[index] = OMISSION;
  return { ...message, content: next };
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Object.keys(value);
  return keys.length === value.length
    && Object.getOwnPropertyNames(value).length === keys.length + 1
    && keys.every((key, index) => key === String(index));
}

function dataValue(target: object, index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, index);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function isExactMarker(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("type") && keys.includes("text")
    && ownData(value, "type") === "text" && ownData(value, "text") === OMISSION_TEXT;
}

function ownData(value: unknown, key: string): unknown {
  if (!isPlainObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
