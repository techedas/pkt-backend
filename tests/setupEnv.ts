// Test defaults. DATABASE_URL may be overridden (e.g. TEST_DATABASE_URL) for the e2e project.
process.env.NODE_ENV = 'test';
process.env.DISABLE_JOBS = 'true';
process.env.JWT_SECRET ??= 'test-access-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789abcdef012345678';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/pkt_test';
