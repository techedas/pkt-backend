import { diffForAudit, flattenForAudit } from '../../src/services/audit.service';
import { decodeScalar, encodeScalar, flattenSettings } from '../../src/config/settingsDefaults';

describe('audit field diff', () => {
  it('flattens nested objects and arrays into dotted paths', () => {
    expect(flattenForAudit({ a: { b: 1 }, list: ['x', { y: true }], d: new Date('2026-01-01T00:00:00Z') })).toEqual({
      'a.b': '1',
      'list[0]': 'x',
      'list[1].y': 'true',
      d: '2026-01-01T00:00:00.000Z',
    });
  });

  it('keeps only changed fields', () => {
    const changes = diffForAudit(
      { name: 'Old', status: 'ACTIVE', options: [{ text: 'A' }, { text: 'B' }] },
      { name: 'New', status: 'ACTIVE', options: [{ text: 'A' }, { text: 'C' }] },
    );
    expect(changes).toEqual([
      { fieldPath: 'name', oldValue: 'Old', newValue: 'New' },
      { fieldPath: 'options[1].text', oldValue: 'B', newValue: 'C' },
    ]);
  });

  it('records creations and deletions', () => {
    expect(diffForAudit(undefined, { code: 'X' })).toEqual([{ fieldPath: 'code', oldValue: null, newValue: 'X' }]);
    expect(diffForAudit({ code: 'X' }, undefined)).toEqual([{ fieldPath: 'code', oldValue: 'X', newValue: null }]);
  });

  it('never stores secrets', () => {
    const changes = diffForAudit(undefined, { email: 'a@b.c', passwordHash: 'hash', temporaryPassword: 'Tmp1!' });
    expect(changes.find((c) => c.fieldPath === 'passwordHash')?.newValue).toBe('[REDACTED]');
    expect(changes.find((c) => c.fieldPath === 'temporaryPassword')?.newValue).toBe('[REDACTED]');
  });
});

describe('settings storage mapping', () => {
  it('stores grouped settings as dotted scalar rows and skips table-backed keys', () => {
    const rows = flattenSettings({
      defaultPassingPercentage: 70,
      passwordPolicy: { minLength: 8, requireUppercase: true, requireLowercase: true, requireNumber: true, requireSpecial: false },
      knowledgeGapThresholds: [{ label: 'Strong', min: 80, max: 100 }],
    });
    expect(rows).toEqual({
      defaultPassingPercentage: 70,
      'passwordPolicy.minLength': 8,
      'passwordPolicy.requireUppercase': true,
      'passwordPolicy.requireLowercase': true,
      'passwordPolicy.requireNumber': true,
      'passwordPolicy.requireSpecial': false,
    });
  });

  it('round-trips typed values', () => {
    for (const v of [70, 0.5, true, false, 'text']) {
      const { valueType, value } = encodeScalar(v);
      expect(decodeScalar(valueType, value)).toBe(v);
    }
  });
});
