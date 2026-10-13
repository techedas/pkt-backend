import { scoreAttempt, topicBreakdown, type EvaluatableQuestion } from '../../src/models/evaluation';

const q = (id: string, topic: string, marks = 1, negativeMarks = 0.25): EvaluatableQuestion => ({
  questionId: id,
  questionType: 'MCQ_SINGLE',
  marks,
  negativeMarks,
  correctOptionIds: [`${id}-correct`],
  topicId: topic,
  topicName: topic,
  difficultyLevel: 'EASY',
});

describe('scoreAttempt', () => {
  const questions = [q('q1', 'Dialing'), q('q2', 'Dialing'), q('q3', 'Inbound'), q('q4', 'Inbound')];

  it('counts correct, incorrect and unanswered and computes percentage', () => {
    const answers = new Map([
      ['q1', { selectedOptionId: 'q1-correct' }],
      ['q2', { selectedOptionId: 'q2-wrong' }],
      ['q3', { selectedOptionId: 'q3-correct' }],
    ]);
    const s = scoreAttempt(questions, answers, { negativeMarking: false, passingPercentage: 50 });
    expect(s).toMatchObject({
      totalQuestions: 4,
      attemptedQuestions: 3,
      correctAnswers: 2,
      incorrectAnswers: 1,
      unansweredQuestions: 1,
      marksObtained: 2,
      totalMarks: 4,
      percentage: 50,
      result: 'PASS',
    });
  });

  it('applies negative marks only to wrong answers when enabled', () => {
    const answers = new Map([
      ['q1', { selectedOptionId: 'q1-correct' }],
      ['q2', { selectedOptionId: 'q2-wrong' }],
      ['q3', { selectedOptionId: null }],
    ]);
    const s = scoreAttempt(questions, answers, { negativeMarking: true, passingPercentage: 50 });
    expect(s.negativeMarks).toBe(0.25);
    expect(s.marksObtained).toBe(0.75);
    expect(s.percentage).toBe(18.75);
    expect(s.result).toBe('FAIL');
  });

  it('ignores negative marks when negative marking is disabled', () => {
    const answers = new Map([['q1', { selectedOptionId: 'wrong' }]]);
    const s = scoreAttempt(questions, answers, { negativeMarking: false, passingPercentage: 0 });
    expect(s.negativeMarks).toBe(0);
    expect(s.marksObtained).toBe(0);
  });

  it('never lets the total drop below zero', () => {
    const answers = new Map(questions.map((x) => [x.questionId, { selectedOptionId: 'wrong' }]));
    const s = scoreAttempt(questions, answers, { negativeMarking: true, passingPercentage: 10 });
    expect(s.marksObtained).toBe(0);
    expect(s.percentage).toBe(0);
  });

  it('passes exactly at the passing percentage', () => {
    const answers = new Map([
      ['q1', { selectedOptionId: 'q1-correct' }],
      ['q2', { selectedOptionId: 'q2-correct' }],
      ['q3', { selectedOptionId: 'q3-correct' }],
    ]);
    expect(scoreAttempt(questions, answers, { negativeMarking: false, passingPercentage: 75 }).result).toBe('PASS');
    expect(scoreAttempt(questions, answers, { negativeMarking: false, passingPercentage: 75.01 }).result).toBe('FAIL');
  });

  it('weights by marks', () => {
    const weighted = [q('a', 'T', 3), q('b', 'T', 1)];
    const s = scoreAttempt(weighted, new Map([['a', { selectedOptionId: 'a-correct' }]]), { negativeMarking: false, passingPercentage: 70 });
    expect(s.totalMarks).toBe(4);
    expect(s.percentage).toBe(75);
  });
});

describe('topicBreakdown', () => {
  it('groups accuracy per topic', () => {
    const questions = [q('q1', 'Dialing'), q('q2', 'Dialing'), q('q3', 'Inbound')];
    const s = scoreAttempt(questions, new Map([['q1', { selectedOptionId: 'q1-correct' }]]), { negativeMarking: false, passingPercentage: 50 });
    const rows = topicBreakdown(questions, s.outcomes);
    expect(rows.find((r) => r.topicName === 'Dialing')).toMatchObject({ total: 2, correct: 1, percentage: 50 });
    expect(rows.find((r) => r.topicName === 'Inbound')).toMatchObject({ total: 1, correct: 0, percentage: 0 });
  });
});
