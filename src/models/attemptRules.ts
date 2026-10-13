/**
 * Attempt business rules (pure functions).
 */
import type { AssessmentStatus, AttemptResult, AttemptStatus, ProductStatus, ReattemptPolicy } from '@prisma/client';

/** Answers arriving up to this long after the deadline are still accepted (network latency). */
export const DEADLINE_GRACE_MS = 5_000;

export const OPEN_ATTEMPT_STATUSES: AttemptStatus[] = ['STARTED', 'IN_PROGRESS'];
export const CLOSED_ATTEMPT_STATUSES: AttemptStatus[] = ['SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED'];

export const isOpenAttempt = (s: AttemptStatus) => OPEN_ATTEMPT_STATUSES.includes(s);

export const isPastDeadline = (deadline: Date, now = new Date(), graceMs = DEADLINE_GRACE_MS) =>
  now.getTime() > deadline.getTime() + graceMs;

export const remainingSeconds = (deadline: Date, now = new Date()) =>
  Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));

/** Configuration copied onto every attempt when it starts. */
export interface AttemptConfig {
  assessmentId: string;
  assessmentCode: string;
  assessmentName: string;
  productId: string;
  productCode: string;
  productName: string;
  passingPercentage: number;
  durationMinutes: number;
  maxAttempts: number;
  negativeMarkingEnabled: boolean;
  allowPreviousQuestion: boolean;
  allowQuestionNavigation: boolean;
  showResultImmediately: boolean;
  showCorrectAnswers: boolean;
  showExplanation: boolean;
  autoSubmitOnTimeout: boolean;
  certificationEnabled: boolean;
  certificationValidityDays: number | null;
  randomizeQuestions: boolean;
  randomizeOptions: boolean;
}

/** Whether the learner may see the score of an attempt now. */
export function isResultVisible(
  cfg: Pick<AttemptConfig, 'showResultImmediately'>,
  assessment: { endDate: Date | null; effectiveStatus: AssessmentStatus },
  now = new Date(),
) {
  if (cfg.showResultImmediately) return true;
  // Results withheld until the assessment window closes.
  return assessment.effectiveStatus === 'EXPIRED' || assessment.effectiveStatus === 'INACTIVE' || (!!assessment.endDate && assessment.endDate < now);
}

export type UserAssessmentStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'PASSED' | 'FAILED' | 'EXPIRED';
export type UserAssessmentAction = 'START' | 'CONTINUE' | 'VIEW_RESULT' | 'REATTEMPT' | 'NONE';

export interface AttemptLite {
  id: string;
  attemptNumber: number;
  status: AttemptStatus;
  result: AttemptResult | null;
  percentage: number;
  deadline: Date;
  submitTime: Date | null;
}

export interface AssessmentLite {
  effectiveStatus: AssessmentStatus;
  endDate: Date | null;
  maxAttempts: number;
  reattemptPolicy: ReattemptPolicy;
  showResultImmediately: boolean;
  productStatus?: ProductStatus;
}

export interface UserAssessmentState {
  status: UserAssessmentStatus;
  action: UserAssessmentAction;
  canStart: boolean;
  blockedReason: string | null;
  blockedCode: string | null;
  attemptsUsed: number;
  attemptsLeft: number;
  openAttemptId: string | null;
  lastAttemptId: string | null;
  bestPercentage: number | null;
  resultVisible: boolean;
}

/**
 * Derive what a learner sees for an assigned assessment and whether a new
 * attempt may start. The same function guards the start endpoint, so the
 * dashboard and the API can never disagree.
 */
export function computeUserAssessmentState(
  a: AssessmentLite,
  attempts: AttemptLite[],
  dueDate: Date | null,
  now = new Date(),
): UserAssessmentState {
  const sorted = [...attempts].sort((x, y) => x.attemptNumber - y.attemptNumber);
  const open = sorted.find((t) => isOpenAttempt(t.status) && !isPastDeadline(t.deadline, now)) ?? null;
  const completed = sorted.filter((t) => !isOpenAttempt(t.status));
  const last = completed[completed.length - 1] ?? null;
  const resultVisible = isResultVisible(a, { endDate: a.endDate, effectiveStatus: a.effectiveStatus }, now);
  const passedAny = completed.some((t) => t.result === 'PASS');
  const attemptsUsed = sorted.length;
  const attemptsLeft = Math.max(0, a.maxAttempts - attemptsUsed);
  const dueExpired = !!dueDate && dueDate < now;
  const productInactive = a.productStatus === 'INACTIVE';

  let blockedCode: string | null = null;
  let blockedReason: string | null = null;
  if (productInactive) [blockedCode, blockedReason] = ['PRODUCT_INACTIVE', 'The product for this assessment is inactive.'];
  else if (a.effectiveStatus === 'EXPIRED') [blockedCode, blockedReason] = ['ASSESSMENT_EXPIRED', 'This assessment has expired.'];
  else if (a.effectiveStatus === 'INACTIVE' || a.effectiveStatus === 'DRAFT')
    [blockedCode, blockedReason] = ['ASSESSMENT_NOT_AVAILABLE', 'This assessment is not available.'];
  else if (a.effectiveStatus === 'PUBLISHED') [blockedCode, blockedReason] = ['ASSESSMENT_NOT_OPEN', 'This assessment has not opened yet.'];
  else if (dueExpired) [blockedCode, blockedReason] = ['ASSIGNMENT_EXPIRED', 'The due date for this assessment has passed.'];
  else if (a.reattemptPolicy === 'ONLY_IF_FAILED' && passedAny)
    [blockedCode, blockedReason] = ['ALREADY_PASSED', 'You have already passed this assessment.'];
  else if (attemptsLeft <= 0) [blockedCode, blockedReason] = ['MAX_ATTEMPTS_REACHED', 'You have used all allowed attempts.'];

  const canStart = !open && !blockedCode;
  const bestPercentage = completed.length ? Math.max(...completed.map((t) => t.percentage)) : null;

  let status: UserAssessmentStatus;
  let action: UserAssessmentAction;
  if (productInactive) {
    status = open ? 'IN_PROGRESS' : last ? (!resultVisible ? 'COMPLETED' : passedAny ? 'PASSED' : 'FAILED') : 'EXPIRED';
    action = 'NONE';
  } else if (open) {
    status = 'IN_PROGRESS';
    action = 'CONTINUE';
  } else if (last) {
    status = !resultVisible ? 'COMPLETED' : passedAny ? 'PASSED' : 'FAILED';
    action = canStart ? 'REATTEMPT' : 'VIEW_RESULT';
  } else if (blockedCode === 'ASSESSMENT_EXPIRED' || blockedCode === 'ASSIGNMENT_EXPIRED' || blockedCode === 'ASSESSMENT_NOT_AVAILABLE') {
    status = 'EXPIRED';
    action = 'NONE';
  } else {
    status = 'NOT_STARTED';
    action = canStart ? 'START' : 'NONE';
  }

  return {
    status,
    action,
    canStart: productInactive ? false : canStart,
    blockedReason: productInactive ? blockedReason : open ? null : blockedReason,
    blockedCode: productInactive ? blockedCode : open ? null : blockedCode,
    attemptsUsed,
    attemptsLeft,
    openAttemptId: productInactive ? null : open?.id ?? null,
    lastAttemptId: last?.id ?? null,
    bestPercentage: resultVisible ? bestPercentage : null,
    resultVisible,
  };
}
