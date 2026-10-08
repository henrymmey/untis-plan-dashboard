export interface Env {
  DB: D1Database;
  PDF_BUCKET: R2Bucket;
  ALLOWED_SENDER: string;
  ISERV_DOMAIN: string;
  EMAIL_FROM: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_SECURITY: string;
  SMTP_USERNAME: string;
  SMTP_PASSWORD: string;
  TURNSTILE_SITEKEY: string;
  TURNSTILE_SECRET: string;
  DEFAULT_CLASS: string;
  API_KEY: string;
}

export interface LessonChange {
  period: string;
  className: string;
  subject?: string;
  teacher?: string;
  room?: string;
  text?: string;
  type?: string;
  raw: string;
}

export interface ParsedPlan {
  planDate: string;
  version: number;
  reportDate?: string;
  className: string;
  lessons: LessonChange[];
  sourceText: string;
}
