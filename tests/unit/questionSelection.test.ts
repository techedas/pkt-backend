import { planAllocation, selectDynamicQuestions, SelectionError, type PoolQuestion } from '../../src/models/questionSelection';

function makePool(spec: Record<string, { EASY: number; MEDIUM: number; HARD: number }>): PoolQuestion[] {
  const pool: PoolQuestion[] = [];
  for (const [topicId, counts] of Object.entries(spec)) {
    for (const d of ['EASY', 'MEDIUM', 'HARD'] as const) {
      for (let i = 0; i < counts[d]; i++) pool.push({ id: `${topicId}-${d}-${i}`, topicId, subTopicId: null, difficultyLevel: d });
    }
  }
  return pool;
}

const pool = makePool({
  basics: { EASY: 4, MEDIUM: 3, HARD: 2 },
  dialing: { EASY: 3, MEDIUM: 4, HARD: 3 },
  inbound: { EASY: 3, MEDIUM: 3, HARD: 3 },
  reporting: { EASY: 4, MEDIUM: 4, HARD: 1 },
  crm: { EASY: 3, MEDIUM: 3, HARD: 3 },
});
const topics = ['basics', 'dialing', 'inbound', 'reporting', 'crm'];

describe('selectDynamicQuestions', () => {
  it('selects the configured number of questions per topic without duplicates', () => {
    const rules = topics.map((t) => ({ topicId: t, questionCount: 5 }));
    const ids = selectDynamicQuestions(pool, rules);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    for (const t of topics) expect(ids.filter((id) => id.startsWith(`${t}-`))).toHaveLength(5);
  });

  it('satisfies topic rules and a difficulty distribution at the same time', () => {
    const rules = topics.map((t) => ({ topicId: t, questionCount: 5 }));
    const distribution = { EASY: 10, MEDIUM: 10, HARD: 5 };
    for (let run = 0; run < 25; run++) {
      const ids = selectDynamicQuestions(pool, rules, distribution);
      expect(ids).toHaveLength(25);
      const byDiff = (d: string) => ids.filter((id) => id.includes(`-${d}-`)).length;
      expect(byDiff('EASY')).toBe(10);
      expect(byDiff('MEDIUM')).toBe(10);
      expect(byDiff('HARD')).toBe(5);
      for (const t of topics) expect(ids.filter((id) => id.startsWith(`${t}-`))).toHaveLength(5);
    }
  });

  it('produces different selections across attempts (randomised)', () => {
    const rules = [{ topicId: 'dialing', questionCount: 3 }];
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) seen.add(selectDynamicQuestions(pool, rules).sort().join(','));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('respects rules with a fixed difficulty', () => {
    const ids = selectDynamicQuestions(pool, [{ topicId: 'dialing', difficultyLevel: 'HARD', questionCount: 3 }]);
    expect(ids.every((id) => id.startsWith('dialing-HARD'))).toBe(true);
  });

  it('fails clearly when a topic lacks questions', () => {
    expect(() => selectDynamicQuestions(pool, [{ topicId: 'reporting', difficultyLevel: 'HARD', questionCount: 2, label: 'Reporting HARD' }])).toThrow(
      SelectionError,
    );
  });

  it('fails when the difficulty distribution cannot be met', () => {
    const rules = [{ topicId: 'reporting', questionCount: 3 }];
    expect(() => planAllocation(pool, rules, { EASY: 0, MEDIUM: 0, HARD: 3 })).toThrow(/cannot satisfy/);
  });

  it('fails when distribution total differs from rules total', () => {
    expect(() => planAllocation(pool, [{ topicId: 'crm', questionCount: 3 }], { EASY: 2 })).toThrow(/totals/);
  });

  it('draws specific rules before broad ones so overlapping rules still work', () => {
    const small = makePool({ a: { EASY: 2, MEDIUM: 0, HARD: 0 }, b: { EASY: 1, MEDIUM: 0, HARD: 0 } });
    // "any topic: 1" + "topic a: 2" works only if the specific rule draws first.
    const ids = selectDynamicQuestions(small, [{ questionCount: 1 }, { topicId: 'a', questionCount: 2 }]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});
