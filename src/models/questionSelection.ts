/**
 * Question selection engine (pure functions, no database access).
 *
 * DYNAMIC assessments define rules such as "5 questions from Dialing" and an
 * optional difficulty distribution such as {EASY: 10, MEDIUM: 10, HARD: 5}.
 * Both constraints must hold at the same time, which is a transportation
 * problem. We solve it as a max-flow:
 *
 *   source --(rule count)--> rule --(eligible questions of difficulty d)--> d --(quota d)--> sink
 *
 * If the max flow equals the total number of questions, the flow on each
 * rule->difficulty edge tells us how many questions to draw from that bucket.
 * Buckets are then sampled at random without replacement.
 */
import type { DifficultyLevel } from '@prisma/client';
import { shuffle } from '../utils/helpers';

export const DIFFICULTIES: DifficultyLevel[] = ['EASY', 'MEDIUM', 'HARD'];

export interface PoolQuestion {
  id: string;
  topicId: string;
  subTopicId: string | null;
  difficultyLevel: DifficultyLevel;
}

export interface SelectionRule {
  id?: string;
  topicId?: string | null;
  subTopicId?: string | null;
  difficultyLevel?: DifficultyLevel | null;
  questionCount: number;
  label?: string;
}

export type DifficultyDistribution = Partial<Record<DifficultyLevel, number>>;

export class SelectionError extends Error {
  constructor(message: string, public readonly details: unknown[] = []) {
    super(message);
    this.name = 'SelectionError';
  }
}

export const ruleMatches = (rule: SelectionRule, q: PoolQuestion) =>
  (!rule.topicId || q.topicId === rule.topicId) &&
  (!rule.subTopicId || q.subTopicId === rule.subTopicId) &&
  (!rule.difficultyLevel || q.difficultyLevel === rule.difficultyLevel);

/** More specific rules draw first so that broad rules do not consume their questions. */
const specificity = (r: SelectionRule) => (r.subTopicId ? 4 : r.topicId ? 2 : 0) + (r.difficultyLevel ? 1 : 0);

// ---------------------------------------------------------------------------
// Tiny Edmonds-Karp max-flow over an adjacency matrix (graphs here have < 60 nodes).
// ---------------------------------------------------------------------------
function maxFlow(capacity: number[][], source: number, sink: number) {
  const n = capacity.length;
  const flow = capacity.map((row) => row.map(() => 0));
  let total = 0;
  for (;;) {
    const parent = new Array<number>(n).fill(-1);
    parent[source] = source;
    const queue = [source];
    // Randomised neighbour order spreads difficulty picks across rules between attempts.
    while (queue.length && parent[sink] === -1) {
      const u = queue.shift()!;
      for (const v of shuffle([...Array(n).keys()])) {
        if (parent[v] === -1 && capacity[u][v] - flow[u][v] > 0) {
          parent[v] = u;
          queue.push(v);
        }
      }
    }
    if (parent[sink] === -1) break;
    let bottleneck = Infinity;
    for (let v = sink; v !== source; v = parent[v]) bottleneck = Math.min(bottleneck, capacity[parent[v]][v] - flow[parent[v]][v]);
    for (let v = sink; v !== source; v = parent[v]) {
      flow[parent[v]][v] += bottleneck;
      flow[v][parent[v]] -= bottleneck;
    }
    total += bottleneck;
  }
  return { total, flow };
}

/**
 * Decide how many questions each rule takes per difficulty.
 * Returns plan[ruleIndex][difficulty] = count.
 */
export function planAllocation(
  pool: PoolQuestion[],
  rules: SelectionRule[],
  distribution?: DifficultyDistribution | null,
): Array<Record<DifficultyLevel, number>> {
  const total = rules.reduce((s, r) => s + r.questionCount, 0);
  const problems: unknown[] = [];

  // Availability per rule & difficulty.
  const available = rules.map((rule) => {
    const counts: Record<DifficultyLevel, number> = { EASY: 0, MEDIUM: 0, HARD: 0 };
    for (const q of pool) if (ruleMatches(rule, q)) counts[q.difficultyLevel]++;
    const sum = counts.EASY + counts.MEDIUM + counts.HARD;
    if (sum < rule.questionCount) {
      problems.push({ rule: rule.label ?? rule.id, required: rule.questionCount, available: sum });
    }
    return counts;
  });
  if (problems.length) throw new SelectionError('Not enough active questions for one or more rules.', problems);

  const dist = distribution && Object.values(distribution).some((v) => (v ?? 0) > 0) ? distribution : null;
  if (!dist) {
    // No distribution: any difficulty mix is acceptable; allocation happens during sampling.
    return rules.map(() => ({ EASY: 0, MEDIUM: 0, HARD: 0 }));
  }

  const distTotal = DIFFICULTIES.reduce((s, d) => s + (dist[d] ?? 0), 0);
  if (distTotal !== total) {
    throw new SelectionError(`Difficulty distribution totals ${distTotal} but the rules total ${total}.`);
  }

  // Nodes: 0 = source, 1..R = rules, R+1..R+3 = difficulties, R+4 = sink
  const R = rules.length;
  const n = R + 5;
  const source = 0;
  const sink = R + 4;
  const cap = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  rules.forEach((rule, i) => {
    cap[source][1 + i] = rule.questionCount;
    DIFFICULTIES.forEach((d, j) => {
      cap[1 + i][R + 1 + j] = available[i][d];
    });
  });
  DIFFICULTIES.forEach((d, j) => {
    cap[R + 1 + j][sink] = dist[d] ?? 0;
  });

  const { total: achieved, flow } = maxFlow(cap, source, sink);
  if (achieved !== total) {
    throw new SelectionError(
      'The question bank cannot satisfy the topic rules and the difficulty distribution at the same time.',
      DIFFICULTIES.map((d) => ({
        difficulty: d,
        required: dist[d] ?? 0,
        availableAcrossRules: available.reduce((s, a) => s + a[d], 0),
      })),
    );
  }
  return rules.map((_, i) => {
    const plan: Record<DifficultyLevel, number> = { EASY: 0, MEDIUM: 0, HARD: 0 };
    DIFFICULTIES.forEach((d, j) => {
      plan[d] = Math.max(0, flow[1 + i][R + 1 + j]);
    });
    return plan;
  });
}

/**
 * Pick question ids for a DYNAMIC assessment. Throws SelectionError when the
 * active question bank cannot satisfy the rules.
 */
export function selectDynamicQuestions(
  pool: PoolQuestion[],
  rules: SelectionRule[],
  distribution?: DifficultyDistribution | null,
): string[] {
  if (!rules.length) throw new SelectionError('No selection rules are configured.');
  const plan = planAllocation(pool, rules, distribution);
  const hasDistribution = plan.some((p) => p.EASY + p.MEDIUM + p.HARD > 0);

  const used = new Set<string>();
  const selected: string[] = [];
  const order = rules.map((r, i) => ({ r, i })).sort((a, b) => specificity(b.r) - specificity(a.r));

  for (const { r, i } of order) {
    const eligible = shuffle(pool.filter((q) => ruleMatches(r, q) && !used.has(q.id)));
    const picks: PoolQuestion[] = [];
    if (hasDistribution) {
      for (const d of DIFFICULTIES) {
        picks.push(...eligible.filter((q) => q.difficultyLevel === d).slice(0, plan[i][d]));
      }
    } else {
      picks.push(...eligible.slice(0, r.questionCount));
    }
    if (picks.length < r.questionCount) {
      throw new SelectionError('Selection rules overlap and compete for the same questions. Make the rules more specific.', [
        { rule: r.label ?? r.id, required: r.questionCount, available: picks.length },
      ]);
    }
    for (const q of picks) {
      used.add(q.id);
      selected.push(q.id);
    }
  }
  return selected;
}
