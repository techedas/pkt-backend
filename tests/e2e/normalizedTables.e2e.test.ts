/**
 * E2E tests for the relational tables that replaced JSON columns and their APIs:
 * question_attachments, assessment_difficulty_distribution, assessment_versions (+ questions/rules/distribution),
 * attempt_question_options, attempt_answer_selections, notification entity columns,
 * audit_log_changes, application_settings rows and knowledge_gap_bands.
 */
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { settingsService } from '../../src/services/settings.service';

let app: Express;
let admin: string;
let learner: string;
let learnerId: string;
const run = `N${Date.now().toString(36).toUpperCase()}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function login(identifier: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ identifier, password });
  expect(res.status).toBe(200);
  return res.body.data as { accessToken: string; user: { id: string } };
}

beforeAll(async () => {
  app = createApp();
  admin = (await login('admin@pkt.local', 'Admin@123')).accessToken;
  const l = await login('user@pkt.local', 'User@123');
  learner = l.accessToken;
  learnerId = l.user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('normalized tables and their APIs', () => {
  let productId: string;
  const topicIds: string[] = [];
  const questionIds: string[] = [];
  let assessmentId: string;

  it('sets up a product with 2 topics x 3 questions (EASY, MEDIUM, HARD)', async () => {
    productId = (await request(app).post('/api/products').set(auth(admin)).send({ productCode: run, productName: `Normalized ${run}` })).body.data.id;
    for (const name of ['Alpha', 'Beta']) {
      topicIds.push((await request(app).post('/api/topics').set(auth(admin)).send({ productId, name })).body.data.id);
    }
    for (const [t, topicId] of topicIds.entries()) {
      for (const difficultyLevel of ['EASY', 'MEDIUM', 'HARD']) {
        const res = await request(app)
          .post('/api/questions')
          .set(auth(admin))
          .send({
            productId,
            topicId,
            difficultyLevel,
            status: 'ACTIVE',
            questionText: `[${run}] topic ${t} ${difficultyLevel} question?`,
            options: [
              { optionText: 'Right', isCorrect: true },
              { optionText: 'Wrong', isCorrect: false },
              { optionText: 'Also wrong', isCorrect: false },
            ],
          });
        expect(res.status).toBe(201);
        questionIds.push(res.body.data.id);
      }
    }
  });

  it('question_attachments: add, list, update, delete; included in question details', async () => {
    const qid = questionIds[0];
    const bad = await request(app).post(`/api/questions/${qid}/attachments`).set(auth(admin)).send({ attachmentType: 'IMAGE', url: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);

    const add = await request(app)
      .post(`/api/questions/${qid}/attachments`)
      .set(auth(admin))
      .send({ attachmentType: 'IMAGE', url: 'https://example.com/diagram.png', caption: 'Dialer flow' });
    expect(add.status).toBe(201);
    const attachmentId = add.body.data.id;

    const list = await request(app).get(`/api/questions/${qid}/attachments`).set(auth(admin));
    expect(list.body.data).toHaveLength(1);

    const upd = await request(app).put(`/api/questions/${qid}/attachments/${attachmentId}`).set(auth(admin)).send({ caption: 'Updated caption' });
    expect(upd.body.data.caption).toBe('Updated caption');

    const detail = await request(app).get(`/api/questions/${qid}`).set(auth(admin));
    expect(detail.body.data.attachments[0]).toMatchObject({ attachmentType: 'IMAGE', caption: 'Updated caption' });

    expect((await request(app).get(`/api/questions/${qid}/attachments`).set(auth(learner))).status).toBe(403);
    expect((await request(app).delete(`/api/questions/${qid}/attachments/${attachmentId}`).set(auth(admin))).status).toBe(200);
    expect(await prisma.questionAttachment.count({ where: { questionId: qid } })).toBe(0);
  });

  it('assessment_difficulty_distribution: create with distribution, read, validate, replace', async () => {
    const res = await request(app)
      .post('/api/assessments')
      .set(auth(admin))
      .send({
        assessmentName: `Normalized ${run}`,
        productId,
        selectionMode: 'DYNAMIC',
        rules: topicIds.map((topicId) => ({ topicId, questionCount: 2 })),
        difficultyDistribution: { EASY: 2, MEDIUM: 2 },
        passingPercentage: 50,
        durationMinutes: 10,
        maxAttempts: 1,
        showCorrectAnswers: true,
      });
    expect(res.status).toBe(201);
    assessmentId = res.body.data.id;
    expect(res.body.data.difficultyDistribution).toEqual({ EASY: 2, MEDIUM: 2 });
    expect(await prisma.assessmentDifficultyDistribution.count({ where: { assessmentId } })).toBe(2);

    const get = await request(app).get(`/api/assessments/${assessmentId}/difficulty-distribution`).set(auth(admin));
    expect(get.body.data).toMatchObject({ distribution: { EASY: 2, MEDIUM: 2 }, rulesTotal: 4 });

    const mismatch = await request(app).put(`/api/assessments/${assessmentId}/difficulty-distribution`).set(auth(admin)).send({ distribution: { EASY: 1 } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('DISTRIBUTION_MISMATCH');

    const put = await request(app).put(`/api/assessments/${assessmentId}/difficulty-distribution`).set(auth(admin)).send({ distribution: { EASY: 2, HARD: 2 } });
    expect(put.status).toBe(200);
    expect(put.body.data.rows).toHaveLength(2);
    expect(put.body.data.distribution).toEqual({ EASY: 2, HARD: 2 });
  });

  it('assessment_versions: publish creates version 1 with rules and distribution; operational edit creates version 2', async () => {
    expect((await request(app).post(`/api/assessments/${assessmentId}/publish`).set(auth(admin))).status).toBe(200);
    let versions = (await request(app).get(`/api/assessments/${assessmentId}/versions`).set(auth(admin))).body.data;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ versionNumber: 1, changeNote: 'Published', passingPercentage: 50, ruleCount: 2 });

    const v1 = (await request(app).get(`/api/assessments/${assessmentId}/versions/${versions[0].id}`).set(auth(admin))).body.data;
    expect(v1.rules).toHaveLength(2);
    expect(v1.difficultyDistribution).toEqual({ EASY: 2, HARD: 2 });

    const locked = await request(app).put(`/api/assessments/${assessmentId}/difficulty-distribution`).set(auth(admin)).send({ distribution: null });
    expect(locked.status).toBe(409);

    await request(app).put(`/api/assessments/${assessmentId}`).set(auth(admin)).send({ assessmentName: `Normalized ${run} (renamed)` });
    versions = (await request(app).get(`/api/assessments/${assessmentId}/versions`).set(auth(admin))).body.data;
    expect(versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    expect(versions[0].assessmentName).toBe(`Normalized ${run} (renamed)`);
  });

  it('attempts run under the latest version; options are snapshot rows; answers reference them', async () => {
    await request(app).post('/api/assignments').set(auth(admin)).send({ assessmentId, targets: [{ assignmentType: 'USER', assignmentReference: learnerId }] });
    const start = await request(app).post(`/api/assessments/${assessmentId}/start`).set(auth(learner));
    expect(start.status).toBe(201);
    expect(start.body.data.assessmentName).toBe(`Normalized ${run} (renamed)`);
    const attemptId = start.body.data.attemptId;

    const attempt = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { version: true } });
    expect(attempt.version.versionNumber).toBe(2);

    const aqs = await prisma.attemptQuestion.findMany({ where: { attemptId }, include: { options: true } });
    expect(aqs).toHaveLength(4);
    // Difficulty distribution EASY 2 / HARD 2 was honoured.
    expect(aqs.filter((q) => q.difficultyLevel === 'EASY')).toHaveLength(2);
    expect(aqs.filter((q) => q.difficultyLevel === 'HARD')).toHaveLength(2);
    for (const q of aqs) {
      expect(q.options).toHaveLength(3);
      expect(q.options.filter((o) => o.isCorrect)).toHaveLength(1);
      expect(q.options.every((o) => o.sourceOptionId)).toBe(true);
    }

    // The exam API serves snapshot option ids (never correctness).
    const exam = await request(app).get(`/api/attempts/${attemptId}/questions`).set(auth(learner));
    const served = exam.body.data.questions[0];
    const snapshotIds = aqs.find((q) => q.questionId === served.questionId)!.options.map((o) => o.id).sort();
    expect(served.options.map((o: { id: string }) => o.id).sort()).toEqual(snapshotIds);
    expect(JSON.stringify(exam.body)).not.toMatch(/isCorrect|sourceOptionId/);

    // Answer everything correctly through the API.
    for (const q of aqs) {
      const right = q.options.find((o) => o.isCorrect)!;
      expect((await request(app).post(`/api/attempts/${attemptId}/answers`).set(auth(learner)).send({ questionId: q.questionId, selectedOptionId: right.id })).status).toBe(200);
    }
    // A question-bank option id is not accepted any more: answers must reference the snapshot.
    const liveOption = await prisma.questionOption.findFirstOrThrow({ where: { questionId: aqs[0].questionId } });
    const liveRes = await request(app).post(`/api/attempts/${attemptId}/answers`).set(auth(learner)).send({ questionId: aqs[0].questionId, selectedOptionId: liveOption.id });
    expect(liveRes.status).toBe(400);

    await request(app).post(`/api/attempts/${attemptId}/submit`).set(auth(learner));
    const result = (await request(app).get(`/api/attempts/${attemptId}/result`).set(auth(learner))).body.data;
    expect(result).toMatchObject({ percentage: 100, result: 'PASS', versionNumber: 2 });

    // Reviewer snapshot API.
    const snap = await request(app).get(`/api/results/${attemptId}/snapshot`).set(auth(admin));
    expect(snap.status).toBe(200);
    expect(snap.body.data.versionNumber).toBe(2);
    expect(snap.body.data.questions[0].options[0]).toHaveProperty('isCorrect');
    expect(snap.body.data.questions.every((q: { answer: { isCorrect: boolean } }) => q.answer.isCorrect)).toBe(true);
    expect((await request(app).get(`/api/results/${attemptId}/snapshot`).set(auth(learner))).status).toBe(403);

    // Notifications carry an entity reference instead of JSON metadata.
    const n = await prisma.notification.findFirst({ where: { userId: learnerId, entityId: attemptId } });
    expect(n).toMatchObject({ entityType: 'AssessmentAttempt', type: 'ASSESSMENT_PASSED' });
  });

  it('audit_log_changes: field-level changes are stored and returned', async () => {
    await request(app).put(`/api/products/${productId}`).set(auth(admin)).send({ productName: `Renamed ${run}`, category: 'Audit Test' });
    const list = await request(app).get(`/api/audit-logs?action=PRODUCT_UPDATED&entityId=${productId}`).set(auth(admin));
    expect(list.body.data[0].changeCount).toBeGreaterThanOrEqual(2);
    const detail = await request(app).get(`/api/audit-logs/${list.body.data[0].id}`).set(auth(admin));
    const byPath = Object.fromEntries(detail.body.data.changes.map((c: { fieldPath: string; oldValue: string; newValue: string }) => [c.fieldPath, c]));
    expect(byPath.productName).toMatchObject({ oldValue: `Normalized ${run}`, newValue: `Renamed ${run}` });
    expect(byPath.category.newValue).toBe('Audit Test');
  });

  describe('settings rows and knowledge-gap bands', () => {
    afterAll(() => settingsService.clearCache());

    it('lists typed rows and updates one row, validated against its group', async () => {
      const entries = (await request(app).get('/api/settings/entries').set(auth(admin))).body.data;
      expect(entries.find((e: { key: string }) => e.key === 'passwordPolicy.minLength')).toMatchObject({ valueType: 'NUMBER' });

      const original = (await request(app).get('/api/settings/entries/sessionTimeoutMinutes').set(auth(admin))).body.data.value;
      const wrongType = await request(app).put('/api/settings/entries/sessionTimeoutMinutes').set(auth(admin)).send({ value: 'soon' });
      expect(wrongType.status).toBe(400);
      const outOfRange = await request(app).put('/api/settings/entries/sessionTimeoutMinutes').set(auth(admin)).send({ value: 1 });
      expect(outOfRange.status).toBe(400);

      const ok = await request(app).put('/api/settings/entries/sessionTimeoutMinutes').set(auth(admin)).send({ value: 90 });
      expect(ok.body.data.value).toBe(90);
      const row = await prisma.applicationSetting.findUniqueOrThrow({ where: { key: 'sessionTimeoutMinutes' } });
      expect(row).toMatchObject({ valueType: 'NUMBER', value: '90' });
      // Grouped view still works for the Settings screen.
      const grouped = (await request(app).get('/api/settings').set(auth(admin))).body.data;
      expect(grouped.find((s: { key: string }) => s.key === 'sessionTimeoutMinutes').value).toBe(90);

      await request(app).put('/api/settings/entries/sessionTimeoutMinutes').set(auth(admin)).send({ value: original });
    });

    it('manages bands as rows with overlap validation', async () => {
      const before = (await request(app).get('/api/settings/knowledge-gap-bands').set(auth(admin))).body.data;
      expect(before.length).toBeGreaterThanOrEqual(1);

      const overlap = await request(app).post('/api/settings/knowledge-gap-bands').set(auth(admin)).send({ label: 'Overlap', min: 50, max: 70 });
      expect(overlap.status).toBe(400);

      // Make room by shrinking the lowest band, add a new band, then restore.
      const lowest = [...before].sort((a, b) => a.minPercentage - b.minPercentage)[0];
      const shrink = await request(app).put(`/api/settings/knowledge-gap-bands/${lowest.id}`).set(auth(admin)).send({ min: 20 });
      expect(shrink.status).toBe(200);
      const created = await request(app).post('/api/settings/knowledge-gap-bands').set(auth(admin)).send({ label: `Critical ${run}`, min: 0, max: 19.99, color: '#d03b3b' });
      expect(created.status).toBe(201);

      const gap = await request(app).get(`/api/reports/knowledge-gap?productId=${productId}`).set(auth(admin));
      expect(gap.body.data.thresholds.map((t: { label: string }) => t.label)).toContain(`Critical ${run}`);

      expect((await request(app).delete(`/api/settings/knowledge-gap-bands/${created.body.data.id}`).set(auth(admin))).status).toBe(200);
      await request(app).put(`/api/settings/knowledge-gap-bands/${lowest.id}`).set(auth(admin)).send({ min: lowest.minPercentage });
      const after = (await request(app).get('/api/settings/knowledge-gap-bands').set(auth(admin))).body.data;
      expect(after.map((b: { label: string; minPercentage: number }) => [b.label, b.minPercentage])).toEqual(
        before.map((b: { label: string; minPercentage: number }) => [b.label, b.minPercentage]),
      );
    });
  });
});
