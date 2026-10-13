import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

/**
 * Aggregation queries for reports. All inputs are bound parameters; filters are
 * composed with Prisma.sql so no user input is ever concatenated into SQL.
 *
 * Table aliases used throughout:  at = assessment_attempts, a = assessments, u = users
 */
export interface ReportScope {
  productIds: string[] | null;
  userIds: string[] | null;
}

export interface ReportFilter {
  productId?: string;
  assessmentId?: string;
  department?: string;
  team?: string;
  userId?: string;
  topicId?: string;
  from?: Date;
  to?: Date;
}

export function attemptConditions(scope: ReportScope, f: ReportFilter = {}): Prisma.Sql {
  const c: Prisma.Sql[] = [Prisma.sql`at.status::text IN ('SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED')`];
  if (scope.productIds) c.push(Prisma.sql`a.product_id = ANY(${scope.productIds}::uuid[])`);
  if (scope.userIds) c.push(Prisma.sql`at.user_id = ANY(${scope.userIds}::uuid[])`);
  if (f.productId) c.push(Prisma.sql`a.product_id = ${f.productId}::uuid`);
  if (f.assessmentId) c.push(Prisma.sql`at.assessment_id = ${f.assessmentId}::uuid`);
  if (f.userId) c.push(Prisma.sql`at.user_id = ${f.userId}::uuid`);
  if (f.department) c.push(Prisma.sql`u.department = ${f.department}`);
  if (f.team) c.push(Prisma.sql`u.team = ${f.team}`);
  if (f.from) c.push(Prisma.sql`at.submit_time >= ${f.from}`);
  if (f.to) c.push(Prisma.sql`at.submit_time <= ${f.to}`);
  return Prisma.join(c, ' AND ');
}

const BASE = Prisma.sql`
  FROM assessment_attempts at
  JOIN assessments a ON a.id = at.assessment_id
  JOIN users u ON u.id = at.user_id`;

export const reportRepository = {
  async attemptTotals(scope: ReportScope, f: ReportFilter) {
    const [row] = await prisma.$queryRaw<
      Array<{ attempts: number; passed: number; failed: number; avg_pct: number | null; avg_duration: number | null; max_pct: number | null; min_pct: number | null }>
    >`
      SELECT COUNT(*)::int AS attempts,
             COUNT(*) FILTER (WHERE at.result::text = 'PASS')::int AS passed,
             COUNT(*) FILTER (WHERE at.result::text = 'FAIL')::int AS failed,
             AVG(at.percentage)::float8 AS avg_pct,
             AVG(at.duration_used_seconds)::float8 AS avg_duration,
             MAX(at.percentage)::float8 AS max_pct,
             MIN(at.percentage)::float8 AS min_pct
      ${BASE}
      WHERE ${attemptConditions(scope, f)}`;
    return row;
  },

  productScores(scope: ReportScope, f: ReportFilter) {
    return prisma.$queryRaw<Array<{ product_id: string; product_code: string; product_name: string; attempts: number; passed: number; avg_pct: number }>>`
      SELECT p.id::text AS product_id, p.product_code, p.product_name,
             COUNT(*)::int AS attempts,
             COUNT(*) FILTER (WHERE at.result::text = 'PASS')::int AS passed,
             AVG(at.percentage)::float8 AS avg_pct
      ${BASE}
      JOIN products p ON p.id = a.product_id
      WHERE ${attemptConditions(scope, f)}
      GROUP BY p.id, p.product_code, p.product_name
      ORDER BY p.product_name`;
  },

  monthlyTrend(scope: ReportScope, f: ReportFilter, months = 12) {
    const since = new Date();
    since.setMonth(since.getMonth() - (months - 1), 1);
    since.setHours(0, 0, 0, 0);
    return prisma.$queryRaw<Array<{ month: string; attempts: number; passed: number; failed: number; avg_pct: number }>>`
      SELECT to_char(date_trunc('month', at.submit_time), 'YYYY-MM') AS month,
             COUNT(*)::int AS attempts,
             COUNT(*) FILTER (WHERE at.result::text = 'PASS')::int AS passed,
             COUNT(*) FILTER (WHERE at.result::text = 'FAIL')::int AS failed,
             AVG(at.percentage)::float8 AS avg_pct
      ${BASE}
      WHERE ${attemptConditions(scope, { ...f, from: f.from && f.from > since ? f.from : since })}
      GROUP BY 1 ORDER BY 1`;
  },

  departmentPerformance(scope: ReportScope, f: ReportFilter) {
    return prisma.$queryRaw<Array<{ department: string; attempts: number; passed: number; avg_pct: number; users: number }>>`
      SELECT COALESCE(u.department, 'Unassigned') AS department,
             COUNT(*)::int AS attempts,
             COUNT(*) FILTER (WHERE at.result::text = 'PASS')::int AS passed,
             AVG(at.percentage)::float8 AS avg_pct,
             COUNT(DISTINCT at.user_id)::int AS users
      ${BASE}
      WHERE ${attemptConditions(scope, f)}
      GROUP BY 1 ORDER BY avg_pct DESC`;
  },

  scoreDistribution(scope: ReportScope, f: ReportFilter) {
    return prisma.$queryRaw<Array<{ bucket: number; attempts: number }>>`
      SELECT LEAST(FLOOR(at.percentage / 10), 9)::int AS bucket, COUNT(*)::int AS attempts
      ${BASE}
      WHERE ${attemptConditions(scope, f)}
      GROUP BY 1 ORDER BY 1`;
  },

  /** Accuracy per topic (and optionally per subtopic) from attempt snapshots. */
  topicPerformance(scope: ReportScope, f: ReportFilter, bySubtopic = false) {
    const subCols = bySubtopic ? Prisma.sql`, aq.sub_topic_id::text AS sub_topic_id, MAX(aq.sub_topic_name) AS sub_topic_name` : Prisma.sql``;
    const subGroup = bySubtopic ? Prisma.sql`, aq.sub_topic_id` : Prisma.sql``;
    const topicFilter = f.topicId ? Prisma.sql`AND aq.topic_id = ${f.topicId}::uuid` : Prisma.sql``;
    return prisma.$queryRaw<
      Array<{
        product_id: string; product_code: string; product_name: string; topic_id: string; topic_name: string;
        sub_topic_id?: string | null; sub_topic_name?: string | null;
        questions: number; answered: number; correct: number; users: number;
      }>
    >`
      SELECT p.id::text AS product_id, p.product_code, p.product_name,
             aq.topic_id::text AS topic_id, MAX(aq.topic_name) AS topic_name ${subCols},
             COUNT(*)::int AS questions,
             COUNT(ans.selected_option_id)::int AS answered,
             COUNT(*) FILTER (WHERE ans.is_correct IS TRUE)::int AS correct,
             COUNT(DISTINCT at.user_id)::int AS users
      FROM attempt_questions aq
      JOIN assessment_attempts at ON at.id = aq.attempt_id
      JOIN assessments a ON a.id = at.assessment_id
      JOIN users u ON u.id = at.user_id
      JOIN products p ON p.id = a.product_id
      LEFT JOIN attempt_answers ans ON ans.attempt_question_id = aq.id
      WHERE ${attemptConditions(scope, f)} ${topicFilter}
      GROUP BY p.id, p.product_code, p.product_name, aq.topic_id ${subGroup}
      ORDER BY p.product_name, topic_name`;
  },

  /** Accuracy per user and topic: drives "who needs training on what". */
  userTopicAccuracy(scope: ReportScope, f: ReportFilter) {
    const topicFilter = f.topicId ? Prisma.sql`AND aq.topic_id = ${f.topicId}::uuid` : Prisma.sql``;
    return prisma.$queryRaw<
      Array<{ user_id: string; employee_id: string; first_name: string; last_name: string; department: string | null; product_id: string; topic_id: string; topic_name: string; questions: number; correct: number }>
    >`
      SELECT u.id::text AS user_id, u.employee_id, u.first_name, u.last_name, u.department,
             a.product_id::text AS product_id, aq.topic_id::text AS topic_id, MAX(aq.topic_name) AS topic_name,
             COUNT(*)::int AS questions,
             COUNT(*) FILTER (WHERE ans.is_correct IS TRUE)::int AS correct
      FROM attempt_questions aq
      JOIN assessment_attempts at ON at.id = aq.attempt_id
      JOIN assessments a ON a.id = at.assessment_id
      JOIN users u ON u.id = at.user_id
      LEFT JOIN attempt_answers ans ON ans.attempt_question_id = aq.id
      WHERE ${attemptConditions(scope, f)} ${topicFilter}
      GROUP BY u.id, a.product_id, aq.topic_id`;
  },

  questionStats(scope: ReportScope, f: ReportFilter) {
    const topicFilter = f.topicId ? Prisma.sql`AND aq.topic_id = ${f.topicId}::uuid` : Prisma.sql``;
    return prisma.$queryRaw<Array<{ question_id: string; served: number; answered: number; correct: number }>>`
      SELECT aq.question_id::text AS question_id,
             COUNT(*)::int AS served,
             COUNT(ans.selected_option_id)::int AS answered,
             COUNT(*) FILTER (WHERE ans.is_correct IS TRUE)::int AS correct
      FROM attempt_questions aq
      JOIN assessment_attempts at ON at.id = aq.attempt_id
      JOIN assessments a ON a.id = at.assessment_id
      JOIN users u ON u.id = at.user_id
      LEFT JOIN attempt_answers ans ON ans.attempt_question_id = aq.id
      WHERE ${attemptConditions(scope, f)} ${topicFilter}
      GROUP BY aq.question_id`;
  },

  /**
   * How often each option was chosen, per question. Picks are grouped by the
   * question-bank option the snapshot was copied from (source_option_id), with
   * the correctness and text exactly as the learners saw them.
   */
  optionDistribution(scope: ReportScope, f: ReportFilter, questionIds: string[]) {
    return prisma.$queryRaw<Array<{ question_id: string; option_id: string; option_text: string; is_correct: boolean; picks: number }>>`
      SELECT ans.question_id::text AS question_id,
             COALESCE(o.source_option_id, o.id)::text AS option_id,
             MAX(o.option_text) AS option_text,
             BOOL_OR(o.is_correct) AS is_correct,
             COUNT(*)::int AS picks
      FROM attempt_answers ans
      JOIN attempt_question_options o ON o.id = ans.selected_option_id
      JOIN assessment_attempts at ON at.id = ans.attempt_id
      JOIN assessments a ON a.id = at.assessment_id
      JOIN users u ON u.id = at.user_id
      WHERE ${attemptConditions(scope, f)}
        AND ans.question_id = ANY(${questionIds}::uuid[])
      GROUP BY ans.question_id, COALESCE(o.source_option_id, o.id)`;
  },
};
