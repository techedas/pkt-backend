-- The JSON -> audit_log_changes backfill treated a missing key and a JSON null as different
-- values, producing rows where nothing actually changed (empty -> empty). Remove them.
DELETE FROM "audit_log_changes" WHERE "old_value" IS NULL AND "new_value" IS NULL;
