-- =============================================================================
-- Normalise every JSON / array column into relational tables.
-- Existing data is copied into the new tables BEFORE the old columns are dropped.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. New enums
-- ---------------------------------------------------------------------------
CREATE TYPE "AttachmentType" AS ENUM ('IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LINK');
CREATE TYPE "SettingValueType" AS ENUM ('NUMBER', 'BOOLEAN', 'STRING');

-- ---------------------------------------------------------------------------
-- 2. New tables
-- ---------------------------------------------------------------------------
CREATE TABLE "question_attachments" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "attachment_type" "AttachmentType" NOT NULL,
    "url" VARCHAR(1000) NOT NULL,
    "caption" VARCHAR(300),
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "question_attachments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessment_difficulty_distribution" (
    "id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "difficulty_level" "DifficultyLevel" NOT NULL,
    "question_count" INTEGER NOT NULL,
    CONSTRAINT "assessment_difficulty_distribution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessment_versions" (
    "id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" UUID,
    "change_note" VARCHAR(300),
    "assessment_code" VARCHAR(50) NOT NULL,
    "assessment_name" VARCHAR(200) NOT NULL,
    "product_id" UUID NOT NULL,
    "product_code" VARCHAR(30) NOT NULL,
    "product_name" VARCHAR(150) NOT NULL,
    "selection_mode" "SelectionMode" NOT NULL,
    "total_questions" INTEGER NOT NULL,
    "total_marks" DOUBLE PRECISION NOT NULL,
    "passing_percentage" DOUBLE PRECISION NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "max_attempts" INTEGER NOT NULL,
    "reattempt_policy" "ReattemptPolicy" NOT NULL,
    "reattempt_same_questions" BOOLEAN NOT NULL,
    "randomize_questions" BOOLEAN NOT NULL,
    "randomize_options" BOOLEAN NOT NULL,
    "allow_previous_question" BOOLEAN NOT NULL,
    "allow_question_navigation" BOOLEAN NOT NULL,
    "show_result_immediately" BOOLEAN NOT NULL,
    "show_correct_answers" BOOLEAN NOT NULL,
    "show_explanation" BOOLEAN NOT NULL,
    "negative_marking_enabled" BOOLEAN NOT NULL,
    "auto_submit_on_timeout" BOOLEAN NOT NULL,
    "certification_enabled" BOOLEAN NOT NULL,
    "certification_validity_days" INTEGER,
    CONSTRAINT "assessment_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessment_version_questions" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    CONSTRAINT "assessment_version_questions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessment_version_rules" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "topic_id" UUID,
    "sub_topic_id" UUID,
    "difficulty_level" "DifficultyLevel",
    "question_count" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "assessment_version_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessment_version_distribution" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "difficulty_level" "DifficultyLevel" NOT NULL,
    "question_count" INTEGER NOT NULL,
    CONSTRAINT "assessment_version_distribution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attempt_question_options" (
    "id" UUID NOT NULL,
    "attempt_question_id" UUID NOT NULL,
    "source_option_id" UUID,
    "option_code" VARCHAR(5) NOT NULL,
    "option_text" TEXT NOT NULL,
    "is_correct" BOOLEAN NOT NULL,
    "display_order" INTEGER NOT NULL,
    CONSTRAINT "attempt_question_options_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attempt_answer_selections" (
    "answer_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    CONSTRAINT "attempt_answer_selections_pkey" PRIMARY KEY ("answer_id","option_id")
);

CREATE TABLE "audit_log_changes" (
    "id" UUID NOT NULL,
    "audit_log_id" UUID NOT NULL,
    "field_path" VARCHAR(300) NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    CONSTRAINT "audit_log_changes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_gap_bands" (
    "id" UUID NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "min_percentage" DOUBLE PRECISION NOT NULL,
    "max_percentage" DOUBLE PRECISION NOT NULL,
    "color" VARCHAR(20),
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "knowledge_gap_bands_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 3. Backfill: assessments -> difficulty distribution + published versions
-- ---------------------------------------------------------------------------
INSERT INTO "assessment_difficulty_distribution" ("id", "assessment_id", "difficulty_level", "question_count")
SELECT gen_random_uuid(), a."id", d.key::"DifficultyLevel", (d.value #>> '{}')::int
FROM "assessments" a
CROSS JOIN LATERAL jsonb_each(a."difficulty_distribution") d
WHERE jsonb_typeof(a."difficulty_distribution") = 'object'
  AND d.key IN ('EASY', 'MEDIUM', 'HARD')
  AND (d.value #>> '{}') ~ '^[0-9]+$'
  AND (d.value #>> '{}')::int > 0;

-- One version for every assessment that was published or has attempts.
INSERT INTO "assessment_versions" (
    "id", "assessment_id", "version_number", "published_at", "published_by", "change_note",
    "assessment_code", "assessment_name", "product_id", "product_code", "product_name",
    "selection_mode", "total_questions", "total_marks", "passing_percentage", "duration_minutes",
    "start_date", "end_date", "max_attempts", "reattempt_policy", "reattempt_same_questions",
    "randomize_questions", "randomize_options", "allow_previous_question", "allow_question_navigation",
    "show_result_immediately", "show_correct_answers", "show_explanation", "negative_marking_enabled",
    "auto_submit_on_timeout", "certification_enabled", "certification_validity_days")
SELECT gen_random_uuid(), a."id", 1, COALESCE(a."published_at", a."created_at"), a."created_by", 'Migrated from published configuration',
    a."assessment_code", a."assessment_name", a."product_id", p."product_code", p."product_name",
    a."selection_mode", a."total_questions", a."total_marks", a."passing_percentage", a."duration_minutes",
    a."start_date", a."end_date", a."max_attempts", a."reattempt_policy", a."reattempt_same_questions",
    a."randomize_questions", a."randomize_options", a."allow_previous_question", a."allow_question_navigation",
    a."show_result_immediately", a."show_correct_answers", a."show_explanation", a."negative_marking_enabled",
    a."auto_submit_on_timeout", a."certification_enabled", a."certification_validity_days"
FROM "assessments" a
JOIN "products" p ON p."id" = a."product_id"
WHERE a."published_at" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "assessment_attempts" t WHERE t."assessment_id" = a."id");

INSERT INTO "assessment_version_questions" ("id", "version_id", "question_id", "sequence")
SELECT gen_random_uuid(), v."id", q."question_id", q."sequence"
FROM "assessment_versions" v JOIN "assessment_questions" q ON q."assessment_id" = v."assessment_id";

INSERT INTO "assessment_version_rules" ("id", "version_id", "topic_id", "sub_topic_id", "difficulty_level", "question_count", "sequence")
SELECT gen_random_uuid(), v."id", r."topic_id", r."sub_topic_id", r."difficulty_level", r."question_count", r."sequence"
FROM "assessment_versions" v JOIN "assessment_question_rules" r ON r."assessment_id" = v."assessment_id";

INSERT INTO "assessment_version_distribution" ("id", "version_id", "difficulty_level", "question_count")
SELECT gen_random_uuid(), v."id", d."difficulty_level", d."question_count"
FROM "assessment_versions" v JOIN "assessment_difficulty_distribution" d ON d."assessment_id" = v."assessment_id";

-- Attempts point at their assessment's version instead of carrying a JSON copy.
ALTER TABLE "assessment_attempts" ADD COLUMN "assessment_version_id" UUID;
UPDATE "assessment_attempts" t SET "assessment_version_id" = v."id"
FROM "assessment_versions" v WHERE v."assessment_id" = t."assessment_id";
ALTER TABLE "assessment_attempts" ALTER COLUMN "assessment_version_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Backfill: attempt option snapshots and answers
-- ---------------------------------------------------------------------------
INSERT INTO "attempt_question_options" ("id", "attempt_question_id", "source_option_id", "option_code", "option_text", "is_correct", "display_order")
SELECT gen_random_uuid(), aq."id", (o.value ->> 'id')::uuid, COALESCE(o.value ->> 'optionCode', chr(64 + o.ord::int)),
       o.value ->> 'optionText', COALESCE((o.value ->> 'isCorrect')::boolean, false),
       COALESCE((o.value ->> 'displayOrder')::int, o.ord::int - 1)
FROM "attempt_questions" aq
CROSS JOIN LATERAL jsonb_array_elements(aq."options_snapshot") WITH ORDINALITY AS o(value, ord);

-- Answers used to store the question-bank option id; re-point them at the snapshot option.
UPDATE "attempt_answers" a SET "selected_option_id" = o."id"
FROM "attempt_question_options" o
WHERE o."attempt_question_id" = a."attempt_question_id" AND o."source_option_id" = a."selected_option_id";
UPDATE "attempt_answers" a SET "selected_option_id" = NULL
WHERE a."selected_option_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "attempt_question_options" o WHERE o."id" = a."selected_option_id");

INSERT INTO "attempt_answer_selections" ("answer_id", "option_id")
SELECT DISTINCT a."id", o."id"
FROM "attempt_answers" a
CROSS JOIN LATERAL unnest(a."selected_option_ids") AS s(sid)
JOIN "attempt_question_options" o ON o."attempt_question_id" = a."attempt_question_id" AND o."source_option_id"::text = s.sid;

-- ---------------------------------------------------------------------------
-- 5. Backfill: notifications -> entity reference columns
-- ---------------------------------------------------------------------------
ALTER TABLE "notifications" ADD COLUMN "entity_type" VARCHAR(50), ADD COLUMN "entity_id" VARCHAR(100);
UPDATE "notifications" SET
  "entity_type" = CASE
    WHEN "metadata" ? 'attemptId' THEN 'AssessmentAttempt'
    WHEN "metadata" ? 'certificateId' THEN 'Certificate'
    WHEN "metadata" ? 'assessmentId' THEN 'Assessment'
  END,
  "entity_id" = COALESCE("metadata" ->> 'attemptId', "metadata" ->> 'certificateId', "metadata" ->> 'assessmentId')
WHERE jsonb_typeof("metadata") = 'object';

-- ---------------------------------------------------------------------------
-- 6. Backfill: audit log old/new JSON -> one row per changed top-level field
-- ---------------------------------------------------------------------------
INSERT INTO "audit_log_changes" ("id", "audit_log_id", "field_path", "old_value", "new_value")
SELECT gen_random_uuid(), l."id", k.key, (l."old_value" -> k.key) #>> '{}', (l."new_value" -> k.key) #>> '{}'
FROM "audit_logs" l
CROSS JOIN LATERAL (
  SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(l."old_value") = 'object' THEN l."old_value" ELSE '{}'::jsonb END) AS key
  UNION
  SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(l."new_value") = 'object' THEN l."new_value" ELSE '{}'::jsonb END)
) k
WHERE (l."old_value" -> k.key) IS DISTINCT FROM (l."new_value" -> k.key);

-- ---------------------------------------------------------------------------
-- 7. Backfill: application settings JSON -> typed rows + knowledge_gap_bands
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "_old_settings" AS
SELECT "key", "value", "description", "updated_by", "updated_at" FROM "application_settings";

DELETE FROM "application_settings";
ALTER TABLE "application_settings" DROP COLUMN "value";
ALTER TABLE "application_settings" ADD COLUMN "value_type" "SettingValueType" NOT NULL, ADD COLUMN "value" VARCHAR(500) NOT NULL;

-- Scalar settings keep their key.
INSERT INTO "application_settings" ("key", "value_type", "value", "description", "updated_by", "updated_at")
SELECT s."key",
       (CASE jsonb_typeof(s."value") WHEN 'number' THEN 'NUMBER' WHEN 'boolean' THEN 'BOOLEAN' ELSE 'STRING' END)::"SettingValueType",
       s."value" #>> '{}', s."description", s."updated_by", s."updated_at"
FROM "_old_settings" s
WHERE jsonb_typeof(s."value") IN ('number', 'boolean', 'string');

-- Grouped settings (passwordPolicy, resultVisibility, questionAnalytics) become "group.field" rows.
INSERT INTO "application_settings" ("key", "value_type", "value", "description", "updated_by", "updated_at")
SELECT s."key" || '.' || e.key,
       (CASE jsonb_typeof(e.value) WHEN 'number' THEN 'NUMBER' WHEN 'boolean' THEN 'BOOLEAN' ELSE 'STRING' END)::"SettingValueType",
       e.value #>> '{}', s."description", s."updated_by", s."updated_at"
FROM "_old_settings" s
CROSS JOIN LATERAL jsonb_each(s."value") e
WHERE jsonb_typeof(s."value") = 'object';

-- Knowledge-gap thresholds become one row per band.
INSERT INTO "knowledge_gap_bands" ("id", "label", "min_percentage", "max_percentage", "color", "sequence", "updated_by", "updated_at")
SELECT gen_random_uuid(), b.value ->> 'label', (b.value ->> 'min')::float8, (b.value ->> 'max')::float8, b.value ->> 'color',
       b.ord::int, s."updated_by", s."updated_at"
FROM "_old_settings" s
CROSS JOIN LATERAL jsonb_array_elements(s."value") WITH ORDINALITY AS b(value, ord)
WHERE s."key" = 'knowledgeGapThresholds' AND jsonb_typeof(s."value") = 'array';

DROP TABLE "_old_settings";

-- ---------------------------------------------------------------------------
-- 8. Drop the JSON / array columns
-- ---------------------------------------------------------------------------
ALTER TABLE "assessment_attempts" DROP COLUMN "config_snapshot";
ALTER TABLE "assessments" DROP COLUMN "difficulty_distribution", DROP COLUMN "published_config";
ALTER TABLE "attempt_answers" DROP COLUMN "selected_option_ids";
ALTER TABLE "attempt_questions" DROP COLUMN "correct_option_ids", DROP COLUMN "options_snapshot";
ALTER TABLE "audit_logs" DROP COLUMN "new_value", DROP COLUMN "old_value";
ALTER TABLE "notifications" DROP COLUMN "metadata";
ALTER TABLE "questions" DROP COLUMN "metadata";

-- ---------------------------------------------------------------------------
-- 9. Indexes and foreign keys
-- ---------------------------------------------------------------------------
CREATE INDEX "question_attachments_question_id_idx" ON "question_attachments"("question_id");
CREATE UNIQUE INDEX "assessment_difficulty_distribution_assessment_id_difficulty_key" ON "assessment_difficulty_distribution"("assessment_id", "difficulty_level");
CREATE UNIQUE INDEX "assessment_versions_assessment_id_version_number_key" ON "assessment_versions"("assessment_id", "version_number");
CREATE INDEX "assessment_version_questions_question_id_idx" ON "assessment_version_questions"("question_id");
CREATE UNIQUE INDEX "assessment_version_questions_version_id_question_id_key" ON "assessment_version_questions"("version_id", "question_id");
CREATE INDEX "assessment_version_rules_version_id_idx" ON "assessment_version_rules"("version_id");
CREATE UNIQUE INDEX "assessment_version_distribution_version_id_difficulty_level_key" ON "assessment_version_distribution"("version_id", "difficulty_level");
CREATE INDEX "attempt_question_options_source_option_id_idx" ON "attempt_question_options"("source_option_id");
CREATE UNIQUE INDEX "attempt_question_options_attempt_question_id_display_order_key" ON "attempt_question_options"("attempt_question_id", "display_order");
CREATE INDEX "attempt_answer_selections_option_id_idx" ON "attempt_answer_selections"("option_id");
CREATE INDEX "audit_log_changes_audit_log_id_idx" ON "audit_log_changes"("audit_log_id");
CREATE UNIQUE INDEX "knowledge_gap_bands_label_key" ON "knowledge_gap_bands"("label");
CREATE INDEX "assessment_attempts_assessment_version_id_idx" ON "assessment_attempts"("assessment_version_id");
CREATE INDEX "attempt_answers_selected_option_id_idx" ON "attempt_answers"("selected_option_id");

ALTER TABLE "question_attachments" ADD CONSTRAINT "question_attachments_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assessment_difficulty_distribution" ADD CONSTRAINT "assessment_difficulty_distribution_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assessment_versions" ADD CONSTRAINT "assessment_versions_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assessment_version_questions" ADD CONSTRAINT "assessment_version_questions_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assessment_version_questions" ADD CONSTRAINT "assessment_version_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assessment_version_rules" ADD CONSTRAINT "assessment_version_rules_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assessment_version_rules" ADD CONSTRAINT "assessment_version_rules_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "product_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assessment_version_rules" ADD CONSTRAINT "assessment_version_rules_sub_topic_id_fkey" FOREIGN KEY ("sub_topic_id") REFERENCES "product_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assessment_version_distribution" ADD CONSTRAINT "assessment_version_distribution_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_assessment_version_id_fkey" FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attempt_question_options" ADD CONSTRAINT "attempt_question_options_attempt_question_id_fkey" FOREIGN KEY ("attempt_question_id") REFERENCES "attempt_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_selected_option_id_fkey" FOREIGN KEY ("selected_option_id") REFERENCES "attempt_question_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attempt_answer_selections" ADD CONSTRAINT "attempt_answer_selections_answer_id_fkey" FOREIGN KEY ("answer_id") REFERENCES "attempt_answers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attempt_answer_selections" ADD CONSTRAINT "attempt_answer_selections_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "attempt_question_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_log_changes" ADD CONSTRAINT "audit_log_changes_audit_log_id_fkey" FOREIGN KEY ("audit_log_id") REFERENCES "audit_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
