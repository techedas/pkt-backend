import crypto from 'node:crypto';

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const percent = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : 0);

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/** Unbiased Fisher-Yates shuffle using a cryptographically secure RNG. Returns a new array. */
export function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Normalise free text for duplicate detection: lower case, collapse whitespace, strip punctuation. */
export function normaliseText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const questionContentHash = (productId: string, questionText: string) =>
  sha256(`${productId}::${normaliseText(questionText)}`);

/** Parse durations such as "15m", "7d", "12h", "30s" into milliseconds. */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const n = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return n * factor;
}

export const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

/** Remove keys whose value is undefined (useful for building Prisma `where` objects). */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
