/**
 * End-to-end API test of the critical functional flow (requirement §54) and
 * the business rules in §42. Runs against a real, migrated and seeded database.
 *
 *   TEST_DATABASE_URL=postgresql://.../pkt_test npm run test:e2e
 */
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';

let app: Express;
const run = Date.now().toString(36).toUpperCase();

async function login(identifier: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ identifier, password });
  expect(res.status).toBe(200);
  return { token: res.body.data.accessToken as string, cookie: res.headers['set-cookie'] as unknown as string[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = createApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('critical flow: admin builds a test, user takes it, admin sees results', () => {
  let admin: string;
  let learner: string;
  let learnerId: string;
  let productId: string;
  const topicIds: Record<string, string> = {};
  const questions: Array<{ id: string; text: string; correct: string; topic: string }> = [];
  let assessmentId: string;
  let attemptId: string;
  let servedIds: string[] = [];

  it('logs in as admin and as learner; learner cannot use admin APIs', async () => {
    admin = (await login('admin@pkt.local', 'Admin@123')).token;
    learner = (await login('PKT0003', 'User@123')).token; // employee ID login
    const me = await request(app).get('/api/auth/me').set(auth(learner));
    expect(me.body.data.email).toBe('user@pkt.local');
    expect(me.body.data).not.toHaveProperty('passwordHash');
    learnerId = me.body.data.id;

    const forbidden = await request(app).get('/api/users').set(auth(learner));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });

    const bad = await request(app).post('/api/auth/login').send({ identifier: 'admin@pkt.local', password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('creates a product with topics and a subtopic', async () => {
    const p = await request(app).post('/api/products').set(auth(admin)).send({ productCode: `E2E${run}`, productName: `E2E Product ${run}`, category: 'Test' });
    expect(p.status).toBe(201);
    productId = p.body.data.id;

    for (const name of ['Dialing', 'Inbound']) {
      const t = await request(app).post('/api/topics').set(auth(admin)).send({ productId, name });
      expect(t.status).toBe(201);
      topicIds[name] = t.body.data.id;
    }
    const sub = await request(app).post('/api/topics').set(auth(admin)).send({ productId, parentId: topicIds.Dialing, name: 'Predictive' });
    expect(sub.status).toBe(201);
    const dup = await request(app).post('/api/topics').set(auth(admin)).send({ productId, name: 'dialing' });
    expect(dup.status).toBe(409);

    const tree = await request(app).get(`/api/topics?productId=${productId}`).set(auth(admin));
    expect(tree.body.data).toHaveLength(2);
    expect(tree.body.data.find((t: { name: string }) => t.name === 'Dialing').children).toHaveLength(1);
  });

  it('adds questions, validates options and rejects duplicates', async () => {
    for (const topic of ['Dialing', 'Inbound']) {
      for (let i = 1; i <= 3; i++) {
        const text = `[${run}] ${topic} question number ${i}?`;
        const res = await request(app)
          .post('/api/questions')
          .set(auth(admin))
          .send({
            productId,
            topicId: topicIds[topic],
            questionText: text,
            difficultyLevel: 'EASY',
            marks: 1,
            status: 'ACTIVE',
            explanation: `Because ${topic} ${i}.`,
            options: [
              { optionText: `Right ${topic} ${i}`, isCorrect: true },
              { optionText: `Wrong A ${i}`, isCorrect: false },
              { optionText: `Wrong B ${i}`, isCorrect: false },
            ],
          });
        expect(res.status).toBe(201);
        questions.push({ id: res.body.data.id, text, correct: `Right ${topic} ${i}`, topic });
      }
    }
    const dup = await request(app)
      .post('/api/questions')
      .set(auth(admin))
      .send({ productId, topicId: topicIds.Dialing, questionText: `[${run}]  dialing QUESTION number 1`, options: [{ optionText: 'a', isCorrect: true }, { optionText: 'b', isCorrect: false }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_QUESTION');

    const twoCorrect = await request(app)
      .post('/api/questions')
      .set(auth(admin))
      .send({ productId, topicId: topicIds.Dialing, questionText: `[${run}] invalid question`, options: [{ optionText: 'a', isCorrect: true }, { optionText: 'b', isCorrect: true }] });
    expect(twoCorrect.status).toBe(400);
    expect(twoCorrect.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('creates a dynamic assessment, checks rules and publishes it', async () => {
    const preview = await request(app)
      .post('/api/assessments/preview-rules')
      .set(auth(admin))
      .send({ productId, rules: [{ topicId: topicIds.Dialing, questionCount: 2 }, { topicId: topicIds.Inbound, questionCount: 5 }] });
    expect(preview.body.data.feasible).toBe(false);

    const res = await request(app)
      .post('/api/assessments')
      .set(auth(admin))
      .send({
        assessmentName: `E2E Assessment ${run}`,
        productId,
        selectionMode: 'DYNAMIC',
        rules: [
          { topicId: topicIds.Dialing, questionCount: 2 },
          { topicId: topicIds.Inbound, questionCount: 2 },
        ],
        passingPercentage: 70,
        durationMinutes: 10,
        maxAttempts: 2,
        reattemptPolicy: 'ONLY_IF_FAILED',
        showResultImmediately: true,
        showCorrectAnswers: true,
        showExplanation: true,
        certificationEnabled: true,
        certificationValidityDays: 365,
      });
    expect(res.status).toBe(201);
    assessmentId = res.body.data.id;
    expect(res.body.data).toMatchObject({ status: 'DRAFT', totalQuestions: 4, totalMarks: 4 });

    // Not assignable while in draft.
    const early = await request(app).post('/api/assignments').set(auth(admin)).send({ assessmentId, targets: [{ assignmentType: 'USER', assignmentReference: learnerId }] });
    expect(early.status).toBe(409);

    const pub = await request(app).post(`/api/assessments/${assessmentId}/publish`).set(auth(admin));
    expect(pub.status).toBe(200);
    expect(pub.body.data.status).toBe('ACTIVE');

    // Scoring configuration is frozen after publishing.
    const locked = await request(app).put(`/api/assessments/${assessmentId}`).set(auth(admin)).send({ passingPercentage: 10 });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('ASSESSMENT_LOCKED');
  });

  it('prevents unassigned users from starting', async () => {
    const res = await request(app).post(`/api/assessments/${assessmentId}/start`).set(auth(learner));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ASSIGNED');
  });

  it('assigns the assessment to the learner, who sees it with a notification', async () => {
    const res = await request(app)
      .post('/api/assignments')
      .set(auth(admin))
      .send({ assessmentId, targets: [{ assignmentType: 'USER', assignmentReference: learnerId }], dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.data.recipients).toBe(1);

    const mine = await request(app).get('/api/user/assessments').set(auth(learner));
    const row = mine.body.data.find((a: { assessmentId: string }) => a.assessmentId === assessmentId);
    expect(row).toMatchObject({ status: 'NOT_STARTED', action: 'START', totalQuestions: 4 });

    const notes = await request(app).get('/api/notifications').set(auth(learner));
    expect(notes.body.data.some((n: { type: string; message: string }) => n.type === 'ASSESSMENT_ASSIGNED' && n.message.includes(run))).toBe(true);
  });

  it('starts the attempt, serves questions without answers, and resumes instead of duplicating', async () => {
    const start = await request(app).post(`/api/assessments/${assessmentId}/start`).set(auth(learner));
    expect(start.status).toBe(201);
    attemptId = start.body.data.attemptId;
    expect(start.body.data.remainingSeconds).toBeGreaterThan(590);

    const again = await request(app).post(`/api/assessments/${assessmentId}/start`).set(auth(learner));
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ attemptId, resumed: true });

    const qs = await request(app).get(`/api/attempts/${attemptId}/questions`).set(auth(learner));
    expect(qs.status).toBe(200);
    expect(qs.body.data.questions).toHaveLength(4);
    const raw = JSON.stringify(qs.body);
    expect(raw).not.toMatch(/isCorrect|correctOption|explanation/);

    // Other users cannot read someone else's attempt.
    const other = (await login('karan.patel@pkt.local', 'User@123')).token;
    expect((await request(app).get(`/api/attempts/${attemptId}/questions`).set(auth(other))).status).toBe(404);
  });

  it('saves every answer immediately; answers survive a reload', async () => {
    const qs = await request(app).get(`/api/attempts/${attemptId}/questions`).set(auth(learner));
    const served = qs.body.data.questions as Array<{ questionId: string; options: Array<{ id: string; optionText: string }> }>;
    servedIds = served.map((q) => q.questionId);
    // 3 correct, 1 wrong => 75% >= 70% => PASS
    for (const [i, q] of served.entries()) {
      const meta = questions.find((x) => x.id === q.questionId)!;
      const choice = i === 0 ? q.options.find((o) => o.optionText !== meta.correct)! : q.options.find((o) => o.optionText === meta.correct)!;
      const res = await request(app).post(`/api/attempts/${attemptId}/answers`).set(auth(learner)).send({ questionId: q.questionId, selectedOptionId: choice.id });
      expect(res.status).toBe(200);
    }
    await request(app).post(`/api/attempts/${attemptId}/answers`).set(auth(learner)).send({ questionId: served[1].questionId, markedForReview: true });

    const invalid = await request(app).post(`/api/attempts/${attemptId}/answers`).set(auth(learner)).send({ questionId: served[0].questionId, selectedOptionId: served[1].options[0].id });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_OPTION');

    const reload = await request(app).get(`/api/attempts/${attemptId}/questions`).set(auth(learner));
    expect(reload.body.data.answers).toHaveLength(4);
    expect(reload.body.data.answers.find((a: { questionId: string }) => a.questionId === served[1].questionId).markedForReview).toBe(true);
    expect(reload.body.data.attempt.remainingSeconds).toBeGreaterThan(0);
  });

  it('submits once, evaluates server-side and blocks resubmission and late answers', async () => {
    const res = await request(app).post(`/api/attempts/${attemptId}/submit`).set(auth(learner));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUBMITTED');

    const twice = await request(app).post(`/api/attempts/${attemptId}/submit`).set(auth(learner));
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ATTEMPT_ALREADY_SUBMITTED');

    const late = await request(app).post(`/api/attempts/${attemptId}/answers`).set(auth(learner)).send({ questionId: questions[0].id, selectedOptionId: null });
    expect(late.status).toBe(409);
  });

  it('shows the result with topic breakdown, review and certificate', async () => {
    const res = await request(app).get(`/api/attempts/${attemptId}/result`).set(auth(learner));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      correctAnswers: 3,
      incorrectAnswers: 1,
      unansweredQuestions: 0,
      marksObtained: 3,
      totalMarks: 4,
      percentage: 75,
      result: 'PASS',
      attemptNumber: 1,
      passingPercentage: 70,
    });
    expect(res.body.data.topicBreakdown).toHaveLength(2);
    expect(res.body.data.review).toHaveLength(4);
    expect(res.body.data.review[0].explanation).toBeTruthy();
    expect(res.body.data.certificate.certificateNumber).toMatch(new RegExp(`^PKT-E2E${run}-\\d{4}-\\d{6}$`));
    expect(res.body.data.reattempt).toMatchObject({ allowed: false });

    const reattempt = await request(app).post(`/api/assessments/${assessmentId}/start`).set(auth(learner));
    expect(reattempt.status).toBe(409);
    expect(reattempt.body.error.code).toBe('ALREADY_PASSED');
  });

  it('keeps historical results unchanged when a question is edited later', async () => {
    const q = questions.find((x) => x.id === servedIds[1])!;
    const current = (await request(app).get(`/api/questions/${q.id}`).set(auth(admin))).body.data;
    const edit = await request(app)
      .put(`/api/questions/${q.id}`)
      .set(auth(admin))
      .send({
        productId,
        topicId: current.topic.id,
        questionText: `${q.text} (edited)`,
        difficultyLevel: 'HARD',
        marks: 5,
        status: 'ACTIVE',
        options: [
          { optionText: 'Brand new correct', isCorrect: true },
          { optionText: 'Brand new wrong', isCorrect: false },
        ],
      });
    expect(edit.status).toBe(200);

    const res = await request(app).get(`/api/attempts/${attemptId}/result`).set(auth(learner));
    expect(res.body.data.percentage).toBe(75);
    expect(res.body.data.totalMarks).toBe(4);
    const reviewed = res.body.data.review.find((r: { questionId: string }) => r.questionId === q.id);
    expect(reviewed.questionText).toBe(q.text);
    expect(reviewed.marks).toBe(1);
    expect(reviewed.isCorrect).toBe(true);
    expect(reviewed.options.find((o: { isCorrect: boolean }) => o.isCorrect).optionText).toBe(q.correct);
  });

  it('reports the result to the admin: results, assessment report, knowledge gap, dashboard, export', async () => {
    const results = await request(app).get(`/api/reports/results?assessmentId=${assessmentId}`).set(auth(admin));
    expect(results.body.data).toHaveLength(1);
    expect(results.body.data[0]).toMatchObject({ employeeId: 'PKT0003', percentage: 75, result: 'PASS' });

    const report = await request(app).get(`/api/reports/assessments/${assessmentId}`).set(auth(admin));
    expect(report.body.data.summary).toMatchObject({ totalAssigned: 1, completed: 1, passed: 1, failed: 0, averageScore: 75 });

    const gap = await request(app).get(`/api/reports/knowledge-gap?productId=${productId}`).set(auth(admin));
    expect(gap.body.data.topics.map((t: { topicName: string }) => t.topicName).sort()).toEqual(['Dialing', 'Inbound']);

    const dash = await request(app).get('/api/dashboard/admin').set(auth(admin));
    expect(dash.body.data.cards.totalAttempts).toBeGreaterThan(0);

    const reviewer = await request(app).get(`/api/results/${attemptId}`).set(auth(admin));
    expect(reviewer.body.data.user.employeeId).toBe('PKT0003');

    const csv = await request(app).get(`/api/reports/export/assessment-results?assessmentId=${assessmentId}`).set(auth(admin));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('PKT0003');

    const audit = await request(app).get('/api/audit-logs?action=ASSESSMENT_PUBLISHED').set(auth(admin));
    expect(audit.body.data.some((l: { entityId: string }) => l.entityId === assessmentId)).toBe(true);
  });

  describe('timer, attempt limits and expiry', () => {
    let manualId: string;

    it('auto-submits when the server deadline has passed and enforces max attempts', async () => {
      const create = await request(app)
        .post('/api/assessments')
        .set(auth(admin))
        .send({
          assessmentName: `E2E Timed ${run}`,
          productId,
          selectionMode: 'MANUAL',
          questionIds: questions.slice(3, 6).map((q) => q.id),
          passingPercentage: 50,
          durationMinutes: 5,
          maxAttempts: 1,
          reattemptPolicy: 'ALWAYS',
          negativeMarkingEnabled: true,
        });
      expect(create.status).toBe(201);
      manualId = create.body.data.id;
      expect((await request(app).post(`/api/assessments/${manualId}/publish`).set(auth(admin))).status).toBe(200);
      await request(app).post('/api/assignments').set(auth(admin)).send({ assessmentId: manualId, targets: [{ assignmentType: 'TEAM', assignmentReference: 'Support Team A' }] });

      const start = await request(app).post(`/api/assessments/${manualId}/start`).set(auth(learner));
      expect(start.status).toBe(201);
      const id = start.body.data.attemptId;

      // Simulate the clock running out (the server timer is the source of truth).
      await prisma.assessmentAttempt.update({ where: { id }, data: { deadline: new Date(Date.now() - 60_000) } });

      const res = await request(app).get(`/api/attempts/${id}/questions`).set(auth(learner));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ATTEMPT_TIME_OVER');
      const attempt = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id } });
      expect(attempt.status).toBe('AUTO_SUBMITTED');
      expect(attempt.unansweredQuestions).toBe(3);

      const again = await request(app).post(`/api/assessments/${manualId}/start`).set(auth(learner));
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('MAX_ATTEMPTS_REACHED');
    });

    it('does not allow an expired assessment to be started', async () => {
      await prisma.assessment.update({ where: { id: manualId }, data: { maxAttempts: 5, endDate: new Date(Date.now() - 1000) } });
      const res = await request(app).post(`/api/assessments/${manualId}/start`).set(auth(learner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ASSESSMENT_EXPIRED');
    });
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const { cookie } = await login('user@pkt.local', 'User@123');
    const first = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(first.status).toBe(200);
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });
});
