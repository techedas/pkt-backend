/* eslint-disable no-console */
/**
 * Idempotent seed: safe to run repeatedly. Creates roles, permissions,
 * settings, development users, products, topics, sample questions, a sample
 * assessment and (on first run) sample attempts for dashboard demos.
 */
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_ROLES, PERMISSION_DESCRIPTIONS, type PermissionCode } from '../src/config/permissions';
import { DEFAULT_SETTING_ROWS, DEFAULT_SETTINGS, encodeScalar, SETTING_DESCRIPTIONS, type SettingKey } from '../src/config/settingsDefaults';
import { questionContentHash } from '../src/utils/helpers';
import { SEED_PRODUCTS, SEED_USERS, VAANI_QUESTIONS, VAANI_TOPICS } from './seedData';

const prisma = new PrismaClient();
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const ASSESSMENT_CODE = 'VAANI-PKT-L1';

async function seedAccessControl() {
  for (const [code, description] of Object.entries(PERMISSION_DESCRIPTIONS)) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, description, module: code.split(':')[0] },
      update: { description, module: code.split(':')[0] },
    });
  }
  const permissions = new Map((await prisma.permission.findMany()).map((p) => [p.code, p.id]));
  for (const role of DEFAULT_ROLES) {
    const r = await prisma.role.upsert({
      where: { code: role.code },
      create: { code: role.code, name: role.name, description: role.description, isSystem: true },
      update: { name: role.name, description: role.description, isSystem: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: r.id } });
    if (role.permissions.length > 0) {
      await prisma.rolePermission.createMany({
        data: role.permissions.map((p: PermissionCode) => ({ roleId: r.id, permissionId: permissions.get(p)! })),
        skipDuplicates: true,
      });
    }
  }
  console.log(`✔ ${DEFAULT_ROLES.length} roles, ${permissions.size} permissions`);
}

async function seedSettings() {
  // Scalar settings: one typed row per key (grouped settings use dotted keys).
  for (const [key, value] of Object.entries(DEFAULT_SETTING_ROWS)) {
    await prisma.applicationSetting.upsert({
      where: { key },
      create: { key, ...encodeScalar(value), description: SETTING_DESCRIPTIONS[key.split('.')[0] as SettingKey] },
      update: {},
    });
  }
  // Knowledge-gap bands live in their own table; only seed when none exist.
  if ((await prisma.knowledgeGapBand.count()) === 0) {
    await prisma.knowledgeGapBand.createMany({
      data: DEFAULT_SETTINGS.knowledgeGapThresholds.map((b, i) => ({
        label: b.label,
        minPercentage: b.min,
        maxPercentage: b.max,
        color: b.color ?? null,
        sequence: i + 1,
      })),
    });
  }
  console.log('✔ application settings and knowledge-gap bands');
}

async function seedProducts(adminId: string) {
  for (const p of SEED_PRODUCTS) {
    await prisma.product.upsert({ where: { productCode: p.productCode }, create: { ...p, createdById: adminId }, update: {} });
  }
  console.log(`✔ ${SEED_PRODUCTS.length} products`);
}

async function seedUsers() {
  const roles = new Map((await prisma.role.findMany()).map((r) => [r.code, r.id]));
  for (const u of SEED_USERS) {
    const passwordHash = await bcrypt.hash(u.password, 12);
    await prisma.user.upsert({
      where: { email: u.email },
      create: {
        employeeId: u.employeeId,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        department: u.department,
        designation: u.designation,
        team: u.team,
        location: u.location,
        productGroup: 'productGroup' in u ? u.productGroup : null,
        roleId: roles.get(u.role)!,
        passwordHash,
      },
      update: {},
    });
  }
  // Second pass: managers and product assignments.
  for (const u of SEED_USERS) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: u.email } });
    if ('manager' in u && u.manager) {
      const manager = await prisma.user.findUniqueOrThrow({ where: { email: u.manager } });
      await prisma.user.update({ where: { id: user.id }, data: { managerId: manager.id } });
    }
    if ('products' in u) {
      for (const code of u.products) {
        const product = await prisma.product.findUnique({ where: { productCode: code } });
        if (product) {
          await prisma.userProduct.upsert({
            where: { userId_productId: { userId: user.id, productId: product.id } },
            create: { userId: user.id, productId: product.id },
            update: {},
          });
        }
      }
    }
  }
  console.log(`✔ ${SEED_USERS.length} users`);
}

async function seedVaaniContent(adminId: string) {
  const vaani = await prisma.product.findUniqueOrThrow({ where: { productCode: 'VAANI' } });
  const topicIds = new Map<string, string>();
  for (const [i, t] of VAANI_TOPICS.entries()) {
    let topic = await prisma.productTopic.findFirst({ where: { productId: vaani.id, parentId: null, name: t.name, deletedAt: null } });
    topic ??= await prisma.productTopic.create({ data: { productId: vaani.id, name: t.name, sequence: i + 1 } });
    topicIds.set(t.name, topic.id);
    for (const [j, s] of t.subtopics.entries()) {
      let sub = await prisma.productTopic.findFirst({ where: { productId: vaani.id, parentId: topic.id, name: s, deletedAt: null } });
      sub ??= await prisma.productTopic.create({ data: { productId: vaani.id, parentId: topic.id, name: s, sequence: j + 1 } });
      topicIds.set(`${t.name}/${s}`, sub.id);
    }
  }

  let created = 0;
  for (const q of VAANI_QUESTIONS) {
    const contentHash = questionContentHash(vaani.id, q.text);
    if (await prisma.question.findFirst({ where: { productId: vaani.id, contentHash, deletedAt: null } })) continue;
    await prisma.question.create({
      data: {
        productId: vaani.id,
        topicId: topicIds.get(q.topic)!,
        subTopicId: q.subtopic ? topicIds.get(`${q.topic}/${q.subtopic}`)! : null,
        questionText: q.text,
        questionType: 'MCQ_SINGLE',
        difficultyLevel: q.difficulty,
        marks: 1,
        negativeMarks: 0,
        explanation: q.explanation,
        status: 'ACTIVE',
        contentHash,
        createdById: adminId,
        options: { create: q.options.map((text, i) => ({ optionCode: LETTERS[i], optionText: text, isCorrect: i === q.correct, sequence: i + 1 })) },
      },
    });
    created++;
  }
  console.log(`✔ VAANI topics and ${created} new questions (${VAANI_QUESTIONS.length} total in seed)`);
  return { vaani, topicIds };
}

async function seedAssessment(adminId: string, vaaniId: string, topicIds: Map<string, string>) {
  let assessment = await prisma.assessment.findUnique({ where: { assessmentCode: ASSESSMENT_CODE } });
  if (assessment) {
    console.log('✔ sample assessment already exists');
    return assessment;
  }
  const now = new Date();
  const rules = VAANI_TOPICS.map((t, i) => ({ topicId: topicIds.get(t.name)!, questionCount: 2, sequence: i + 1 }));
  const config = {
    assessmentCode: ASSESSMENT_CODE,
    assessmentName: 'VAANI Product Knowledge Test – Level 1',
    description: 'Baseline product knowledge check covering VAANI basics, dialing, inbound, campaigns and reports.',
    instructions: 'Read each question carefully. Choose the single best answer.',
    productId: vaaniId,
    selectionMode: 'DYNAMIC' as const,
    totalQuestions: 10,
    totalMarks: 10,
    passingPercentage: 70,
    durationMinutes: 15,
    startDate: new Date(now.getTime() - 60 * 86_400_000),
    endDate: new Date(now.getTime() + 180 * 86_400_000),
    maxAttempts: 2,
    reattemptPolicy: 'ONLY_IF_FAILED' as const,
    randomizeQuestions: true,
    randomizeOptions: true,
    allowPreviousQuestion: true,
    allowQuestionNavigation: true,
    showResultImmediately: true,
    showCorrectAnswers: true,
    showExplanation: true,
    negativeMarkingEnabled: false,
    autoSubmitOnTimeout: true,
    certificationEnabled: true,
    certificationValidityDays: 365,
  };
  const draft = await prisma.assessment.create({
    data: { ...config, status: 'DRAFT', createdById: adminId, rules: { create: rules } },
  });
  // Publish through the real service: validates the rules and records the frozen
  // configuration in assessment_versions.
  process.env.DISABLE_JOBS = 'true';
  const { assessmentService } = await import('../src/services/assessment.service');
  const { loadAuthUser } = await import('../src/middlewares/auth');
  await assessmentService.publish({ user: (await loadAuthUser(adminId))! }, draft.id);
  assessment = await prisma.assessment.findUniqueOrThrow({ where: { id: draft.id } });
  console.log('✔ sample assessment "VAANI Product Knowledge Test – Level 1" (published)');
  return assessment;
}

/**
 * Run a few demo learners through the real attempt engine so dashboards,
 * reports and knowledge-gap analysis have data on first start.
 */
async function seedSampleAttempts(assessmentId: string) {
  if ((await prisma.assessmentAttempt.count({ where: { assessmentId } })) > 0) return;
  process.env.DISABLE_JOBS = 'true';
  const { attemptService } = await import('../src/services/attempt.service');
  const { loadAuthUser } = await import('../src/middlewares/auth');

  // Accuracy profile per learner and per topic to create a realistic knowledge-gap picture.
  const profiles: Record<string, { base: number; weak?: string; strong?: string }> = {
    'karan.patel@pkt.local': { base: 0.9, weak: 'Reports' },
    'sneha.reddy@pkt.local': { base: 0.8, weak: 'Campaign' },
    'arjun.nair@pkt.local': { base: 0.55, strong: 'Dialing' },
    'fatima.khan@pkt.local': { base: 0.75, weak: 'Reports' },
    'rohan.gupta@pkt.local': { base: 0.45, weak: 'Inbound' },
  };

  let count = 0;
  for (const [email, p] of Object.entries(profiles)) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const auth = await loadAuthUser(user.id);
    const ctx = { user: auth! };
    const started = await attemptService.start(ctx, assessmentId);
    const questions = await prisma.attemptQuestion.findMany({ where: { attemptId: started.attemptId }, include: { options: true } });
    for (const q of questions) {
      let chance = p.base;
      if (p.weak && q.topicName === p.weak) chance -= 0.4;
      if (p.strong && q.topicName === p.strong) chance += 0.3;
      const options = q.options;
      const pick = Math.random() < chance ? options.find((o) => o.isCorrect)! : options.find((o) => !o.isCorrect)!;
      await attemptService.saveAnswer(ctx, started.attemptId, { questionId: q.questionId, selectedOptionId: pick.id });
    }
    await attemptService.submit(ctx, started.attemptId);
    count++;
  }
  console.log(`✔ ${count} sample attempts for dashboard demos`);
}

async function main() {
  console.log('Seeding PKT database…');
  await seedAccessControl();
  await seedSettings();
  await seedUsers();
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@pkt.local' } });
  await seedProducts(admin.id);
  // Product admin assignment needs products to exist.
  await seedUsers();
  const { vaani, topicIds } = await seedVaaniContent(admin.id);
  const assessment = await seedAssessment(admin.id, vaani.id, topicIds);
  await seedSampleAttempts(assessment.id);

  console.log('\nDevelopment accounts (DO NOT USE IN PRODUCTION):');
  for (const u of SEED_USERS.slice(0, 6)) console.log(`  ${u.role.padEnd(14)} ${u.email.padEnd(26)} ${u.password}`);
  console.log('  Demo learners: karan.patel@pkt.local, sneha.reddy@pkt.local, ... (password User@123)');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
