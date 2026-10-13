/**
 * Answer evaluation (pure functions).
 * Each question type registers an evaluator; new types (MCQ_MULTIPLE, TEXT, ...)
 * are added here without touching the attempt workflow.
 */
import type { QuestionType } from '@prisma/client';
import { percent, round2 } from '../utils/helpers';

export interface SnapshotOption {
  id: string;
  optionCode: string;
  optionText: string;
  isCorrect: boolean;
  displayOrder: number;
}

export interface EvaluatableQuestion {
  questionId: string;
  questionType: QuestionType;
  marks: number;
  negativeMarks: number;
  correctOptionIds: string[];
  topicId: string;
  topicName: string;
  difficultyLevel: string;
}

export interface EvaluatableAnswer {
  selectedOptionId: string | null;
  selectedOptionIds?: string[];
  answerText?: string | null;
}

export interface QuestionOutcome {
  questionId: string;
  answered: boolean;
  isCorrect: boolean | null;
  /** Positive marks earned (0 when wrong/unanswered). */
  marksAwarded: number;
  /** Marks deducted for a wrong answer (0 when negative marking is off). */
  penalty: number;
}

type Evaluator = (q: EvaluatableQuestion, a: EvaluatableAnswer | undefined, negativeMarking: boolean) => QuestionOutcome;

const singleChoice: Evaluator = (q, a, negativeMarking) => {
  const selected = a?.selectedOptionId ?? null;
  if (!selected) return { questionId: q.questionId, answered: false, isCorrect: null, marksAwarded: 0, penalty: 0 };
  const isCorrect = q.correctOptionIds.includes(selected);
  return {
    questionId: q.questionId,
    answered: true,
    isCorrect,
    marksAwarded: isCorrect ? q.marks : 0,
    penalty: !isCorrect && negativeMarking ? q.negativeMarks : 0,
  };
};

const multipleChoice: Evaluator = (q, a, negativeMarking) => {
  const selected = [...new Set(a?.selectedOptionIds ?? [])];
  if (!selected.length) return { questionId: q.questionId, answered: false, isCorrect: null, marksAwarded: 0, penalty: 0 };
  const isCorrect = selected.length === q.correctOptionIds.length && selected.every((id) => q.correctOptionIds.includes(id));
  return {
    questionId: q.questionId,
    answered: true,
    isCorrect,
    marksAwarded: isCorrect ? q.marks : 0,
    penalty: !isCorrect && negativeMarking ? q.negativeMarks : 0,
  };
};

const evaluators: Partial<Record<QuestionType, Evaluator>> = {
  MCQ_SINGLE: singleChoice,
  TRUE_FALSE: singleChoice,
  MCQ_MULTIPLE: multipleChoice,
};

export function evaluateQuestion(q: EvaluatableQuestion, a: EvaluatableAnswer | undefined, negativeMarking: boolean) {
  const evaluator = evaluators[q.questionType];
  if (!evaluator) throw new Error(`No evaluator registered for question type ${q.questionType}`);
  return evaluator(q, a, negativeMarking);
}

export interface AttemptScore {
  totalQuestions: number;
  attemptedQuestions: number;
  correctAnswers: number;
  incorrectAnswers: number;
  unansweredQuestions: number;
  positiveMarks: number;
  negativeMarks: number;
  marksObtained: number;
  totalMarks: number;
  percentage: number;
  result: 'PASS' | 'FAIL';
  outcomes: QuestionOutcome[];
}

/**
 * Score a whole attempt.
 * percentage = marksObtained / totalMarks * 100, where marksObtained never drops below 0.
 */
export function scoreAttempt(
  questions: EvaluatableQuestion[],
  answers: Map<string, EvaluatableAnswer>,
  opts: { negativeMarking: boolean; passingPercentage: number },
): AttemptScore {
  const outcomes = questions.map((q) => evaluateQuestion(q, answers.get(q.questionId), opts.negativeMarking));
  const totalMarks = round2(questions.reduce((s, q) => s + q.marks, 0));
  const positive = round2(outcomes.reduce((s, o) => s + o.marksAwarded, 0));
  const negative = round2(outcomes.reduce((s, o) => s + o.penalty, 0));
  const marksObtained = round2(Math.max(0, positive - negative));
  const pct = percent(marksObtained, totalMarks);
  const attempted = outcomes.filter((o) => o.answered).length;
  const correct = outcomes.filter((o) => o.isCorrect === true).length;
  return {
    totalQuestions: questions.length,
    attemptedQuestions: attempted,
    correctAnswers: correct,
    incorrectAnswers: attempted - correct,
    unansweredQuestions: questions.length - attempted,
    positiveMarks: positive,
    negativeMarks: negative,
    marksObtained,
    totalMarks,
    percentage: pct,
    result: pct >= opts.passingPercentage ? 'PASS' : 'FAIL',
    outcomes,
  };
}

/** Topic-wise accuracy for the result screen and knowledge-gap analysis. */
export function topicBreakdown(questions: EvaluatableQuestion[], outcomes: QuestionOutcome[]) {
  const byId = new Map(outcomes.map((o) => [o.questionId, o]));
  const groups = new Map<string, { topicId: string; topicName: string; total: number; correct: number; marks: number; earned: number }>();
  for (const q of questions) {
    const g = groups.get(q.topicId) ?? { topicId: q.topicId, topicName: q.topicName, total: 0, correct: 0, marks: 0, earned: 0 };
    const o = byId.get(q.questionId);
    g.total++;
    g.marks += q.marks;
    if (o?.isCorrect) {
      g.correct++;
      g.earned += o.marksAwarded;
    }
    groups.set(q.topicId, g);
  }
  return [...groups.values()].map((g) => ({ ...g, percentage: percent(g.correct, g.total) }));
}
