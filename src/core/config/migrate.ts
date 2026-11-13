type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Moves the legacy Copilot settings (`copilotBin`, `runs.defaultModel`, `runs.models`) into `providers.copilot`.
// Values already present in `providers.copilot` win. Returns the input untouched when nothing is legacy.
export function migrateLegacyConfig(raw: unknown): { raw: unknown; changed: boolean } {
  if (!isRecord(raw)) return { raw, changed: false };
  const runs = isRecord(raw.runs) ? raw.runs : undefined;
  const legacy = {
    bin: raw.copilotBin,
    defaultModel: runs?.defaultModel,
    models: runs?.models,
  };
  const hasLegacy =
    Object.hasOwn(raw, 'copilotBin') ||
    (runs !== undefined && (Object.hasOwn(runs, 'defaultModel') || Object.hasOwn(runs, 'models')));
  if (!hasLegacy) return { raw, changed: false };

  const providers = isRecord(raw.providers) ? raw.providers : {};
  const copilot = isRecord(providers.copilot) ? providers.copilot : {};
  const migrated: RecordValue = { ...copilot };
  for (const [key, value] of Object.entries(legacy)) {
    if (value !== undefined && !Object.hasOwn(migrated, key)) migrated[key] = value;
  }

  const next: RecordValue = { ...raw, providers: { ...providers, copilot: migrated } };
  delete next.copilotBin;
  if (runs !== undefined) {
    const rest = { ...runs };
    delete rest.defaultModel;
    delete rest.models;
    next.runs = rest;
  }
  return { raw: next, changed: true };
}
