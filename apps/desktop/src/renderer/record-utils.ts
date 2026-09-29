export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

/** A plain object, or null for anything else (arrays included). */
export function recordOrNull(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

export function rows(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}
