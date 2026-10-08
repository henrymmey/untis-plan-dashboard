export interface Env {
  DB: D1Database;
  PDF_BUCKET: R2Bucket;
  ALLOWED_SENDER: string;
  TARGET_CLASS: string;
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
