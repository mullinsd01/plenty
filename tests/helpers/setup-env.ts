import { loadEnvConfig } from "@next/env";

// Each test file: load .env, then force the test database.
loadEnvConfig(process.cwd());
const testUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL?.replace(/\/([^/?]+)(\?|$)/, "/plenty_test$2");
if (testUrl) process.env.DATABASE_URL = testUrl;
process.env.AI_PROVIDER = "local";
