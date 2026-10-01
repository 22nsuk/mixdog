export const PROVIDER_MODELS_EVENT = 'provider-models-changed';

export interface ProviderModelsChange {
  /** Per-renderer instance id, so the originator can ignore its own echo. */
  origin: string;
}

export function readProviderModelsChange(value: unknown): ProviderModelsChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const origin = (value as Record<string, unknown>).origin;
  return typeof origin === 'string' && origin.length > 0 && origin.length <= 128 ? { origin } : null;
}
