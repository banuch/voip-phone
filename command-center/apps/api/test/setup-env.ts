// Runs before any test module is loaded (imports are hoisted, so env must be set here).
process.env.NODE_ENV = 'test';
process.env.WORKERS_ENABLED = 'false';
process.env.SIP_DRIVER = 'simulated';
process.env.REDIS_URL = '';
process.env.LOG_LEVEL = 'error';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
