import type { AssessmentStatus } from '@prisma/client';

interface StatusInput {
  status: AssessmentStatus;
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * The stored status only records the admin's intent (DRAFT, published, INACTIVE).
 * Whether a published assessment is open right now depends on its date window:
 *   PUBLISHED  - published, start date in the future
 *   ACTIVE     - published and within its window
 *   EXPIRED    - end date has passed
 * A background job persists these transitions; this function is the single source of truth.
 */
export function effectiveAssessmentStatus(a: StatusInput, now = new Date()): AssessmentStatus {
  if (a.status === 'DRAFT' || a.status === 'INACTIVE') return a.status;
  if (a.endDate && a.endDate < now) return 'EXPIRED';
  if (a.startDate && a.startDate > now) return 'PUBLISHED';
  return 'ACTIVE';
}

export const isPublishedLike = (s: AssessmentStatus) => s === 'PUBLISHED' || s === 'ACTIVE' || s === 'EXPIRED';

/** Configuration that is frozen once an assessment is published. */
export const FROZEN_ASSESSMENT_FIELDS = [
  'productId', 'selectionMode', 'totalQuestions', 'passingPercentage', 'durationMinutes', 'maxAttempts',
  'reattemptPolicy', 'reattemptSameQuestions', 'randomizeQuestions', 'randomizeOptions', 'allowPreviousQuestion',
  'allowQuestionNavigation', 'showResultImmediately', 'showCorrectAnswers', 'showExplanation',
  'negativeMarkingEnabled', 'autoSubmitOnTimeout', 'certificationEnabled', 'certificationValidityDays',
  'difficultyDistribution', 'startDate', 'assessmentCode',
] as const;

/** Fields that may still change after publishing (they do not affect scoring). */
export const OPERATIONAL_ASSESSMENT_FIELDS = ['assessmentName', 'description', 'instructions', 'endDate'] as const;
