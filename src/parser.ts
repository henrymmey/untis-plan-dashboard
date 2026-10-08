import type { LessonChange, ParsedPlan } from "./types";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toIsoDate(day: number, month: number, year: number): string {
  return year + "-" + pad(month) + "-" + pad(day);
}

function inferPlanYear(reportYear: number, reportMonth: number, planMonth: number): number {
  return planMonth < reportMonth ? reportYear + 1 : reportYear;
}

function findReportDate(text: string): { iso: string; year: number; month: number } | undefined {
  const match = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\s*\((\d+)\)/);
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { iso: toIsoDate(day, month, year), year, month };
}

function findPlanDate(text: string, report: ReturnType<typeof findReportDate>): string {
  const match = text.match(/Vertretungsplan\s+Klassen\s+(\d{1,2})\.(\d{1,2})\.\s*\//i);
  if (!match) throw new Error("Could not find the plan date. Expected 'Vertretungsplan Klassen DD.MM. / ...'.");
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error("Invalid plan date.");
  const year = report ? inferPlanYear(report.year, report.month, month) : new Date().getUTCFullYear();
  return toIsoDate(day, month, year);
}

function findVersion(text: string): number {
  const match = text.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\s*\((\d+)\)/);
  if (!match) throw new Error("Could not find the Untis version '(N)' in the PDF.");
  const version = Number(match[1]);
  if (!Number.isInteger(version) || version < 1) throw new Error("Invalid plan version.");
  return version;
}

function normalizeLines(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseClassLine(line: string): LessonChange | undefined {
  const match = line.match(/^([0-9]+(?:\/\/[0-9]+)?)\s+K\s+((?:5|6|7|8|9|10)-[GORH]\d+)\s+(.+)$/i);
  if (!match) return undefined;

  const period = match[1];
  const className = match[2].toUpperCase();
  const rest = match[3].trim();
  const tokens = rest.split(" ").filter(Boolean);
  const types = ["Statt-Vertretung", "Raum-Vtr.", "Raum beachten", "Vertretung", "Betreuung", "Freisetzung", "Entfall"];

  let type: string | undefined;
  for (const candidate of types) {
    if (rest.includes(candidate)) {
      type = candidate;
      break;
    }
  }

  return {
    period,
    className,
    subject: tokens[0],
    teacher: tokens[1],
    room: tokens[2],
    text: type ? rest.slice(rest.indexOf(type) + type.length).trim() || undefined : undefined,
    type,
    raw: line,
  };
}

export function parsePlanText(text: string): ParsedPlan[] {
  const report = findReportDate(text);
  const planDate = findPlanDate(text, report);
  const version = findVersion(text);
  const lessons = normalizeLines(text)
    .map(parseClassLine)
    .filter((value): value is LessonChange => Boolean(value));

  const byClass = new Map<string, LessonChange[]>();
  for (const lesson of lessons) {
    const current = byClass.get(lesson.className) ?? [];
    current.push(lesson);
    byClass.set(lesson.className, current);
  }

  return [...byClass.entries()].map(([className, classLessons]) => ({
    planDate,
    version,
    reportDate: report?.iso,
    className,
    lessons: classLessons,
    sourceText: text,
  }));
}
