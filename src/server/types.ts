export type HealthStatus = 'unknown' | 'healthy' | 'unhealthy';

export type ClassificationMode = 'auto' | 'adult' | 'normal';

export interface SourceRecord {
  id: number;
  sourceKey: string;
  name: string;
  api: string;
  detail: string | null;
  comment: string | null;
  classificationMode: ClassificationMode;
  isAdult: boolean;
  enabled: boolean;
  ignoreHealthCheck: boolean;
  healthStatus: HealthStatus;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  checkIntervalHours: number;
  requestTimeoutMs: number;
  failureThreshold: number;
  cacheTime: number;
  nextCheckAt: string | null;
}

export interface AppConfig {
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  subscriptionToken?: string;
  port: number;
  databasePath: string;
  adultKeywordsExtra: string[];
}
