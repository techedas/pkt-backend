import type { KnowledgeGapBand } from '@prisma/client';
import { prisma } from '../config/database';
import {
  decodeScalar,
  DEFAULT_SETTING_ROWS,
  DEFAULT_SETTINGS,
  encodeScalar,
  flattenSettings,
  SETTING_DESCRIPTIONS,
  settingSchemas,
  thresholdBandSchema,
  type AppSettings,
  type ScalarType,
  type SettingKey,
} from '../config/settingsDefaults';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { auditService } from './audit.service';

const CACHE_TTL_MS = 30_000;
let cache: { value: AppSettings; loadedAt: number } | null = null;

type Band = AppSettings['knowledgeGapThresholds'][number];

const toBand = (b: KnowledgeGapBand): Band => ({
  label: b.label,
  min: b.minPercentage,
  max: b.maxPercentage,
  ...(b.color ? { color: b.color } : {}),
});

const descriptionFor = (storageKey: string) => {
  const top = storageKey.split('.')[0] as SettingKey;
  return SETTING_DESCRIPTIONS[top] ?? null;
};

/** Rebuild the typed settings object from scalar rows + the bands table. */
async function loadAll(): Promise<AppSettings> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.value;
  const [rows, bands] = await Promise.all([
    prisma.applicationSetting.findMany(),
    prisma.knowledgeGapBand.findMany({ orderBy: [{ sequence: 'asc' }, { minPercentage: 'desc' }] }),
  ]);
  const merged: AppSettings = structuredClone(DEFAULT_SETTINGS);
  const target = merged as unknown as Record<string, unknown>;
  for (const row of rows) {
    const value = decodeScalar(row.valueType as ScalarType, row.value);
    const [top, sub] = row.key.split('.');
    if (!(top in settingSchemas)) continue;
    if (sub) {
      const group = target[top];
      if (group && typeof group === 'object') (group as Record<string, unknown>)[sub] = value;
    } else {
      target[top] = value;
    }
  }
  if (bands.length) merged.knowledgeGapThresholds = bands.map(toBand);

  // A malformed stored value falls back to the default instead of breaking the app.
  for (const key of Object.keys(settingSchemas) as SettingKey[]) {
    if (!settingSchemas[key].safeParse(merged[key]).success) (target as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
  }
  cache = { value: merged, loadedAt: Date.now() };
  return merged;
}

function assertBandsValid(bands: Band[]) {
  const parsed = settingSchemas.knowledgeGapThresholds.safeParse(bands);
  if (!parsed.success) throw AppError.badRequest(`Invalid bands: ${parsed.error.issues[0]?.message}`, 'VALIDATION_ERROR');
  const labels = bands.map((b) => b.label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw AppError.badRequest('Band labels must be unique.', 'VALIDATION_ERROR');
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min <= sorted[i - 1].max) {
      throw AppError.badRequest(`Bands "${sorted[i - 1].label}" and "${sorted[i].label}" overlap.`, 'VALIDATION_ERROR');
    }
  }
}

/** Replace all bands in one transaction (used by the grouped settings update). */
async function replaceBands(userId: string, bands: Band[]) {
  assertBandsValid(bands);
  const ordered = [...bands].sort((a, b) => b.min - a.min);
  await prisma.$transaction([
    prisma.knowledgeGapBand.deleteMany(),
    prisma.knowledgeGapBand.createMany({
      data: ordered.map((b, i) => ({ label: b.label, minPercentage: b.min, maxPercentage: b.max, color: b.color ?? null, sequence: i + 1, updatedById: userId })),
    }),
  ]);
}

export const settingsService = {
  getAll: loadAll,

  async get<K extends SettingKey>(key: K): Promise<AppSettings[K]> {
    return (await loadAll())[key];
  },

  /** Grouped view used by the Settings screen: one entry per setting (objects for grouped settings). */
  async list() {
    const values = await loadAll();
    return (Object.keys(settingSchemas) as SettingKey[]).map((key) => ({
      key,
      value: values[key],
      description: SETTING_DESCRIPTIONS[key],
    }));
  },

  /** Update one or more grouped settings; each is validated, then stored as rows / bands. */
  async update(ctx: RequestContext, updates: Partial<Record<string, unknown>>) {
    const current = await loadAll();
    const validated: Partial<AppSettings> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in settingSchemas)) throw AppError.badRequest(`Unknown setting: ${key}`, 'UNKNOWN_SETTING');
      const parsed = settingSchemas[key as SettingKey].safeParse(value);
      if (!parsed.success) {
        throw AppError.badRequest(`Invalid value for ${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 'VALIDATION_ERROR');
      }
      (validated as Record<string, unknown>)[key] = parsed.data;
    }

    if (validated.knowledgeGapThresholds) await replaceBands(ctx.user.id, validated.knowledgeGapThresholds);
    const rows = flattenSettings(validated);
    await prisma.$transaction(
      Object.entries(rows).map(([key, value]) => {
        const encoded = encodeScalar(value);
        return prisma.applicationSetting.upsert({
          where: { key },
          create: { key, ...encoded, description: descriptionFor(key), updatedById: ctx.user.id },
          update: { ...encoded, updatedById: ctx.user.id },
        });
      }),
    );
    cache = null;

    const oldValue = Object.fromEntries(Object.keys(validated).map((k) => [k, current[k as SettingKey]]));
    await auditService.log(ctx, 'SETTINGS_UPDATED', 'ApplicationSetting', null, oldValue, validated);
    return this.list();
  },

  // -------------------------------------------------------------------------
  // Row-level access to application_settings
  // -------------------------------------------------------------------------

  /** Every stored scalar setting row (with defaults for rows not stored yet). */
  async listEntries() {
    const rows = await prisma.applicationSetting.findMany({ orderBy: { key: 'asc' } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return Object.entries(DEFAULT_SETTING_ROWS).map(([key, def]) => {
      const row = byKey.get(key);
      return {
        key,
        valueType: row?.valueType ?? encodeScalar(def).valueType,
        value: row ? decodeScalar(row.valueType as ScalarType, row.value) : def,
        defaultValue: def,
        description: row?.description ?? descriptionFor(key),
        updatedAt: row?.updatedAt ?? null,
        updatedById: row?.updatedById ?? null,
      };
    });
  },

  async getEntry(key: string) {
    const entry = (await this.listEntries()).find((e) => e.key === key);
    if (!entry) throw AppError.notFound('Setting', 'UNKNOWN_SETTING');
    return entry;
  },

  /** Set a single scalar row, e.g. "passwordPolicy.minLength" = 10 (validated against its group). */
  async setEntry(ctx: RequestContext, key: string, value: unknown) {
    if (!(key in DEFAULT_SETTING_ROWS)) throw AppError.notFound('Setting', 'UNKNOWN_SETTING');
    const expected = encodeScalar(DEFAULT_SETTING_ROWS[key]).valueType;
    const actual = typeof value === 'number' ? 'NUMBER' : typeof value === 'boolean' ? 'BOOLEAN' : typeof value === 'string' ? 'STRING' : null;
    if (actual !== expected) throw AppError.badRequest(`${key} must be a ${expected.toLowerCase()}.`, 'VALIDATION_ERROR');

    const [top, sub] = key.split('.') as [SettingKey, string | undefined];
    const current = await loadAll();
    const next = sub ? { ...(current[top] as object), [sub]: value } : value;
    await this.update(ctx, { [top]: next });
    return this.getEntry(key);
  },

  // -------------------------------------------------------------------------
  // Knowledge-gap bands (knowledge_gap_bands table)
  // -------------------------------------------------------------------------

  listBands() {
    return prisma.knowledgeGapBand.findMany({ orderBy: [{ sequence: 'asc' }, { minPercentage: 'desc' }] });
  },

  async createBand(ctx: RequestContext, input: Band) {
    const existing = (await this.listBands()).map(toBand);
    assertBandsValid([...existing, input]);
    const band = await prisma.knowledgeGapBand.create({
      data: { label: input.label, minPercentage: input.min, maxPercentage: input.max, color: input.color ?? null, sequence: existing.length + 1, updatedById: ctx.user.id },
    });
    cache = null;
    await auditService.log(ctx, 'KNOWLEDGE_GAP_BAND_CREATED', 'KnowledgeGapBand', band.id, undefined, input);
    return band;
  },

  async updateBand(ctx: RequestContext, id: string, input: Partial<Band> & { sequence?: number }) {
    const all = await this.listBands();
    const band = all.find((b) => b.id === id);
    if (!band) throw AppError.notFound('Band');
    const merged: Band = { ...toBand(band), ...Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'sequence' && v !== undefined)) };
    thresholdBandSchema.parse(merged);
    assertBandsValid([...all.filter((b) => b.id !== id).map(toBand), merged]);
    const updated = await prisma.knowledgeGapBand.update({
      where: { id },
      data: {
        label: merged.label,
        minPercentage: merged.min,
        maxPercentage: merged.max,
        color: merged.color ?? null,
        ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
        updatedById: ctx.user.id,
      },
    });
    cache = null;
    await auditService.log(ctx, 'KNOWLEDGE_GAP_BAND_UPDATED', 'KnowledgeGapBand', id, toBand(band), merged);
    return updated;
  },

  async deleteBand(ctx: RequestContext, id: string) {
    const all = await this.listBands();
    const band = all.find((b) => b.id === id);
    if (!band) throw AppError.notFound('Band');
    if (all.length <= 1) throw AppError.badRequest('At least one band is required.', 'VALIDATION_ERROR');
    await prisma.knowledgeGapBand.delete({ where: { id } });
    cache = null;
    await auditService.log(ctx, 'KNOWLEDGE_GAP_BAND_DELETED', 'KnowledgeGapBand', id, toBand(band), undefined);
  },

  /** Classify a percentage into the configured knowledge-gap band. */
  async bandFor(percentage: number) {
    const bands = await this.get('knowledgeGapThresholds');
    return classifyBand(bands, percentage);
  },

  clearCache() {
    cache = null;
  },
};

export function classifyBand(bands: AppSettings['knowledgeGapThresholds'], percentage: number) {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  return sorted.find((b) => percentage >= b.min) ?? sorted[sorted.length - 1];
}
