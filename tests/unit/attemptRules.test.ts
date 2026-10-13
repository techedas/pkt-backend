import { effectiveAssessmentStatus } from '../../src/models/assessmentStatus';
import { computeUserAssessmentState, isPastDeadline, remainingSeconds, type AssessmentLite, type AttemptLite } from '../../src/models/attemptRules';

const now = new Date('2026-06-15T10:00:00Z');
const minutes = (m: number) => new Date(now.getTime() + m * 60_000);

const assessment = (over: Partial<AssessmentLite> = {}): AssessmentLite => ({
  effectiveStatus: 'ACTIVE',
  endDate: null,
  maxAttempts: 2,
  reattemptPolicy: 'ONLY_IF_FAILED',
  showResultImmediately: true,
  ...over,
});

const attempt = (over: Partial<AttemptLite> = {}): AttemptLite => ({
  id: 'a1',
  attemptNumber: 1,
  status: 'SUBMITTED',
  result: 'FAIL',
  percentage: 40,
  deadline: minutes(-30),
  submitTime: minutes(-40),
  ...over,
});

describe('computeUserAssessmentState', () => {
  it('allows starting when nothing has been attempted', () => {
    const s = computeUserAssessmentState(assessment(), [], null, now);
    expect(s).toMatchObject({ status: 'NOT_STARTED', action: 'START', canStart: true, attemptsLeft: 2 });
  });

  it('continues an open attempt within its deadline', () => {
    const s = computeUserAssessmentState(assessment(), [attempt({ status: 'IN_PROGRESS', result: null, deadline: minutes(10) })], null, now);
    expect(s).toMatchObject({ status: 'IN_PROGRESS', action: 'CONTINUE', canStart: false, openAttemptId: 'a1' });
  });

  it('offers a reattempt after failing with attempts left', () => {
    const s = computeUserAssessmentState(assessment(), [attempt()], null, now);
    expect(s).toMatchObject({ status: 'FAILED', action: 'REATTEMPT', canStart: true, attemptsLeft: 1 });
  });

  it('blocks when max attempts are used', () => {
    const s = computeUserAssessmentState(assessment(), [attempt(), attempt({ id: 'a2', attemptNumber: 2 })], null, now);
    expect(s).toMatchObject({ status: 'FAILED', action: 'VIEW_RESULT', canStart: false, blockedCode: 'MAX_ATTEMPTS_REACHED' });
  });

  it('blocks reattempt after passing when policy is ONLY_IF_FAILED', () => {
    const s = computeUserAssessmentState(assessment(), [attempt({ result: 'PASS', percentage: 90 })], null, now);
    expect(s).toMatchObject({ status: 'PASSED', canStart: false, blockedCode: 'ALREADY_PASSED' });
  });

  it('allows reattempt after passing when policy is ALWAYS', () => {
    const s = computeUserAssessmentState(assessment({ reattemptPolicy: 'ALWAYS' }), [attempt({ result: 'PASS' })], null, now);
    expect(s.canStart).toBe(true);
  });

  it('marks expired assessments as EXPIRED and not startable', () => {
    const s = computeUserAssessmentState(assessment({ effectiveStatus: 'EXPIRED' }), [], null, now);
    expect(s).toMatchObject({ status: 'EXPIRED', action: 'NONE', canStart: false, blockedCode: 'ASSESSMENT_EXPIRED' });
  });

  it('blocks when the assignment due date has passed', () => {
    const s = computeUserAssessmentState(assessment(), [], minutes(-1), now);
    expect(s).toMatchObject({ status: 'EXPIRED', blockedCode: 'ASSIGNMENT_EXPIRED' });
  });

  it('hides the result until the window closes when results are not immediate', () => {
    const s = computeUserAssessmentState(assessment({ showResultImmediately: false, endDate: minutes(60) }), [attempt({ result: 'PASS' })], null, now);
    expect(s).toMatchObject({ status: 'COMPLETED', resultVisible: false, bestPercentage: null });
  });
});

describe('timer helpers', () => {
  it('computes remaining seconds from the server deadline', () => {
    expect(remainingSeconds(minutes(2), now)).toBe(120);
    expect(remainingSeconds(minutes(-2), now)).toBe(0);
  });

  it('applies a short grace period after the deadline', () => {
    expect(isPastDeadline(new Date(now.getTime() - 3_000), now)).toBe(false);
    expect(isPastDeadline(new Date(now.getTime() - 6_000), now)).toBe(true);
  });
});

describe('effectiveAssessmentStatus', () => {
  it('derives status from the date window', () => {
    expect(effectiveAssessmentStatus({ status: 'ACTIVE', startDate: minutes(-10), endDate: minutes(10) }, now)).toBe('ACTIVE');
    expect(effectiveAssessmentStatus({ status: 'PUBLISHED', startDate: minutes(10), endDate: null }, now)).toBe('PUBLISHED');
    expect(effectiveAssessmentStatus({ status: 'ACTIVE', startDate: null, endDate: minutes(-1) }, now)).toBe('EXPIRED');
    expect(effectiveAssessmentStatus({ status: 'INACTIVE', startDate: null, endDate: null }, now)).toBe('INACTIVE');
    expect(effectiveAssessmentStatus({ status: 'DRAFT', startDate: null, endDate: minutes(-1) }, now)).toBe('DRAFT');
  });
});
