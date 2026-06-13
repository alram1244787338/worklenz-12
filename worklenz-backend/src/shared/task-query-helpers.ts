import moment from "moment";

/**
 * Canonical sort order used across task list, Gantt chart, and reporting export.
 * All endpoints that list tasks for a project should use this same ordering
 * so that the user sees a consistent sequence regardless of which view they open.
 *
 * sort_order is the user-controlled drag-and-drop position.
 * created_at DESC breaks ties for tasks that share the same sort_order value.
 */
export const TASK_CANONICAL_SORT = "sort_order, created_at DESC";

/**
 * Build an archived-filter clause using a parameterized approach.
 *
 * When `includeArchived` is false (the default for most views), we exclude
 * projects the user has personally archived. The userId is injected via a
 * parameter placeholder ($N) rather than string interpolation to prevent
 * SQL injection.
 *
 * @param includeArchived  If true, no filter is applied.
 * @param paramIndex       The $N parameter index for the userId value.
 * @returns SQL clause string (with leading AND when applicable).
 */
export function buildArchivedProjectClause(includeArchived: boolean, paramIndex: number): string {
  if (includeArchived) return "";
  return `AND t.project_id NOT IN (SELECT project_id FROM archived_projects WHERE project_id = t.project_id AND archived_projects.user_id = $${paramIndex})`;
}

/**
 * Same as buildArchivedProjectClause but for a table aliased differently.
 * Used in contexts where the table alias is not "t" (e.g., "p" for projects).
 */
export function buildArchivedProjectClauseForAlias(
  alias: string,
  includeArchived: boolean,
  paramIndex: number
): string {
  if (includeArchived) return "";
  return `AND ${alias}.project_id NOT IN (SELECT project_id FROM archived_projects WHERE project_id = ${alias}.project_id AND archived_projects.user_id = $${paramIndex})`;
}

/**
 * Format a date for export in a timezone-safe way.
 *
 * Dates coming from PostgreSQL TIMESTAMP columns are returned in the server's
 * timezone. To avoid off-by-one-day issues when the server timezone differs
 * from the user's, we always format using UTC after parsing. This matches the
 * behaviour the frontend expects: a date stored as 2024-06-15 00:00:00 should
 * export as "2024-06-15" regardless of server locale.
 *
 * @param dateValue  The raw date value from the database (string or Date).
 * @param format     Moment format string (default "YYYY-MM-DD").
 * @returns Formatted date string, or "-" if the value is null/undefined/invalid.
 */
export function formatDateForExport(dateValue: string | Date | null | undefined, format = "YYYY-MM-DD"): string {
  if (!dateValue) return "-";
  const m = moment.utc(dateValue);
  return m.isValid() ? m.format(format) : "-";
}

/**
 * Safe integer conversion that handles null, undefined, and NaN.
 * Mirrors the shared `int()` utility but usable without importing the full module.
 */
export function safeInt(value: any): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : Math.trunc(n);
}

/**
 * Build a date-range filter clause for task end_date using parameterized queries.
 *
 * @param startDate  Start of range (inclusive), as YYYY-MM-DD.
 * @param endDate    End of range (inclusive), as YYYY-MM-DD.
 * @param startParam The $N index for the start date parameter.
 * @param endParam   The $N index for the end date parameter.
 * @returns SQL clause with leading AND.
 */
export function buildDateRangeClause(
  startDate: string | null,
  endDate: string | null,
  startParam: number,
  endParam: number
): string {
  if (!startDate || !endDate) return "";
  return `AND t.end_date::DATE >= $${startParam}::DATE AND t.end_date::DATE <= $${endParam}::DATE`;
}
