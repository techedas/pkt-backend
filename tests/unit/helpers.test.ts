import { DEFAULT_SETTINGS } from '../../src/config/settingsDefaults';
import { passwordPolicyErrors } from '../../src/services/auth/passwordPolicy';
import { classifyBand } from '../../src/services/settings.service';
import { normaliseText, parseDurationMs, percent, questionContentHash, round2, shuffle } from '../../src/utils/helpers';
import { buildPagination, resolveSort } from '../../src/utils/pagination';

describe('helpers', () => {
  it('rounds and computes percentages safely', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(percent(21, 25)).toBe(84);
    expect(percent(1, 0)).toBe(0);
  });

  it('parses durations', () => {
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('7d')).toBe(604_800_000);
    expect(() => parseDurationMs('soon')).toThrow();
  });

  it('shuffles without losing items', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(items);
    expect(out.sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('detects duplicate questions regardless of case, spacing and punctuation', () => {
    expect(normaliseText('  Which  dialing mode?? ')).toBe('which dialing mode');
    expect(questionContentHash('p1', 'Which dialing mode predicts agent availability?')).toBe(
      questionContentHash('p1', 'which DIALING mode predicts agent   availability'),
    );
    expect(questionContentHash('p1', 'x question')).not.toBe(questionContentHash('p2', 'x question'));
  });
});

describe('pagination', () => {
  it('builds pagination metadata', () => {
    expect(buildPagination({ page: 1, pageSize: 20 }, 125)).toEqual({ page: 1, pageSize: 20, total: 125, totalPages: 7 });
    expect(buildPagination({ page: 1, pageSize: 20 }, 0).totalPages).toBe(1);
  });

  it('only allows whitelisted sort fields', () => {
    expect(resolveSort('email', ['email', 'createdAt'] as const, 'createdAt')).toBe('email');
    expect(resolveSort('passwordHash', ['email', 'createdAt'] as const, 'createdAt')).toBe('createdAt');
  });
});

describe('password policy', () => {
  const policy = DEFAULT_SETTINGS.passwordPolicy;
  it('accepts a compliant password', () => expect(passwordPolicyErrors('Secure123', policy)).toEqual([]));
  it('lists every missing rule', () => {
    expect(passwordPolicyErrors('abc', policy)).toEqual(['at least 8 characters', 'an uppercase letter', 'a number']);
  });
});

describe('knowledge-gap bands', () => {
  const bands = DEFAULT_SETTINGS.knowledgeGapThresholds;
  it.each([
    [92, 'Strong'],
    [80, 'Strong'],
    [79.5, 'Moderate'],
    [60, 'Moderate'],
    [59.99, 'Training Required'],
    [0, 'Training Required'],
  ])('%s%% -> %s', (pct, label) => {
    expect(classifyBand(bands, pct).label).toBe(label);
  });
});
