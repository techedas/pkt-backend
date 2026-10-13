/**
 * Application settings: keys, defaults and validation.
 * Values live in the `application_settings` table; these defaults are used for
 * seeding and as a fallback when a key is missing.
 */
import { z } from 'zod';

export const thresholdBandSchema = z.object({
  label: z.string().min(1).max(50),
  min: z.number().min(0).max(100),
  max: z.number().min(0).max(100),
  color: z.string().max(20).optional(),
});

export const settingSchemas = {
  defaultPassingPercentage: z.number().min(0).max(100),
  defaultDurationMinutes: z.number().int().min(1).max(600),
  maxTestAttempts: z.number().int().min(1).max(50),
  knowledgeGapThresholds: z
    .array(thresholdBandSchema)
    .min(1)
    .max(10)
    .refine((bands) => bands.every((b) => b.min <= b.max), 'Each band needs min <= max'),
  passwordPolicy: z.object({
    minLength: z.number().int().min(6).max(128),
    requireUppercase: z.boolean(),
    requireLowercase: z.boolean(),
    requireNumber: z.boolean(),
    requireSpecial: z.boolean(),
  }),
  sessionTimeoutMinutes: z.number().int().min(5).max(24 * 60),
  resultVisibility: z.object({
    showResultImmediately: z.boolean(),
    showCorrectAnswers: z.boolean(),
    showExplanation: z.boolean(),
  }),
  certificationValidityDays: z.number().int().min(1).max(3650),
  questionAnalytics: z.object({
    minAttempts: z.number().int().min(1),
    veryEasyAbove: z.number().min(0).max(100),
    difficultBelow: z.number().min(0).max(100),
    ambiguousDistractorShare: z.number().min(0).max(100),
  }),
  notificationDueSoonHours: z.number().int().min(1).max(24 * 14),
  certificationExpiryReminderDays: z.number().int().min(1).max(365),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;
export type AppSettings = { [K in SettingKey]: SettingValue<K> };

export const DEFAULT_SETTINGS: AppSettings = {
  defaultPassingPercentage: 70,
  defaultDurationMinutes: 30,
  maxTestAttempts: 3,
  knowledgeGapThresholds: [
    // Status palette: good / warning / critical. Always shown with the band label, never colour alone.
    { label: 'Strong', min: 80, max: 100, color: '#0ca30c' },
    { label: 'Moderate', min: 60, max: 79.99, color: '#fab219' },
    { label: 'Training Required', min: 0, max: 59.99, color: '#d03b3b' },
  ],
  passwordPolicy: {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: false,
  },
  sessionTimeoutMinutes: 60,
  resultVisibility: {
    showResultImmediately: true,
    showCorrectAnswers: false,
    showExplanation: false,
  },
  certificationValidityDays: 365,
  questionAnalytics: {
    minAttempts: 10,
    veryEasyAbove: 90,
    difficultBelow: 30,
    ambiguousDistractorShare: 40,
  },
  notificationDueSoonHours: 48,
  certificationExpiryReminderDays: 30,
};

// ---------------------------------------------------------------------------
// Storage mapping. Settings are stored as typed scalar rows in `application_settings`
// (grouped settings use dotted keys, e.g. "passwordPolicy.minLength"); knowledge-gap
// thresholds live in their own `knowledge_gap_bands` table.
// ---------------------------------------------------------------------------
export type ScalarType = 'NUMBER' | 'BOOLEAN' | 'STRING';
export type ScalarValue = number | boolean | string;

/** Top-level keys stored in a dedicated table instead of application_settings. */
export const TABLE_BACKED_KEYS = ['knowledgeGapThresholds'] as const;

export const typeOfScalar = (v: ScalarValue): ScalarType =>
  typeof v === 'number' ? 'NUMBER' : typeof v === 'boolean' ? 'BOOLEAN' : 'STRING';

export function encodeScalar(v: ScalarValue): { valueType: ScalarType; value: string } {
  return { valueType: typeOfScalar(v), value: String(v) };
}

export function decodeScalar(valueType: ScalarType, value: string): ScalarValue {
  if (valueType === 'NUMBER') return Number(value);
  if (valueType === 'BOOLEAN') return value === 'true';
  return value;
}

/** Split settings into storage rows: { "defaultPassingPercentage": 70, "passwordPolicy.minLength": 8, ... }. */
export function flattenSettings(values: Partial<AppSettings>): Record<string, ScalarValue> {
  const out: Record<string, ScalarValue> = {};
  for (const [key, value] of Object.entries(values)) {
    if ((TABLE_BACKED_KEYS as readonly string[]).includes(key) || value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [sub, subValue] of Object.entries(value)) out[`${key}.${sub}`] = subValue as ScalarValue;
    } else {
      out[key] = value as ScalarValue;
    }
  }
  return out;
}

/** Every storage key with its default value (used for seeding and validation of single-row updates). */
export const DEFAULT_SETTING_ROWS = flattenSettings(DEFAULT_SETTINGS);

export const SETTING_DESCRIPTIONS: Record<SettingKey, string> = {
  defaultPassingPercentage: 'Default passing percentage for new assessments',
  defaultDurationMinutes: 'Default test duration (minutes) for new assessments',
  maxTestAttempts: 'Default maximum attempts for new assessments',
  knowledgeGapThresholds: 'Score bands used by knowledge-gap analysis',
  passwordPolicy: 'Password complexity rules',
  sessionTimeoutMinutes: 'Idle time after which a login session expires',
  resultVisibility: 'Default result visibility for new assessments',
  certificationValidityDays: 'Default validity period of certificates',
  questionAnalytics: 'Thresholds used to flag questions for review',
  notificationDueSoonHours: 'Send "due soon" reminders this many hours before the due date',
  certificationExpiryReminderDays: 'Warn users this many days before a certificate expires',
};
