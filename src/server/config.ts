import type { AppConfig } from './types.js';

const DEFAULT_PORT = 3000;
const DEFAULT_DATABASE_PATH = '/app/data/app.db';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be configured`);
  }

  return value;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

export function loadConfig(): AppConfig {
  const subscriptionToken = process.env.SUBSCRIPTION_TOKEN?.trim();

  return {
    adminUsername: requiredEnvironment('ADMIN_USERNAME'),
    adminPassword: requiredEnvironment('ADMIN_PASSWORD'),
    sessionSecret: requiredEnvironment('SESSION_SECRET'),
    subscriptionToken: subscriptionToken || undefined,
    port: parsePort(process.env.PORT?.trim()),
    databasePath: process.env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH,
    adultKeywordsExtra: (process.env.ADULT_KEYWORDS_EXTRA ?? '')
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean),
  };
}
