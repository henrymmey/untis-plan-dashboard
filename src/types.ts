export interface EmailSender {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

export interface Env {
  DB: D1Database;
  PDF_BUCKET: R2Bucket;
  EMAIL: EmailSender;
  ALLOWED_SENDER: string;
  ISERV_DOMAIN: string;
  EMAIL_FROM: string;
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
