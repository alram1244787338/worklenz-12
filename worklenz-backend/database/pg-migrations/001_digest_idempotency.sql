-- Migration: Digest and notification idempotency fixes
-- Adds digest_logs table for deduplication and updates the three main
-- digest/notification SQL functions with proper filtering.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. digest_logs table for idempotent sends
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS digest_logs (
    id          UUID                     DEFAULT uuid_generate_v4() NOT NULL,
    user_id     UUID                                                NOT NULL,
    digest_type TEXT                                                NOT NULL,
    email       TEXT                                                NOT NULL,
    sent_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP  NOT NULL,
    CONSTRAINT digest_logs_pk PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_logs_user_type_date
    ON digest_logs (user_id, digest_type, (sent_at::date));

CREATE INDEX IF NOT EXISTS idx_digest_logs_sent_at ON digest_logs (sent_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. get_daily_digest() — return user_id, filter to users with digest enabled
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_daily_digest() RETURNS json
    LANGUAGE plpgsql
AS
$$
DECLARE
    _result JSON;
BEGIN
    SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(rec))), '[]'::JSON)
    INTO _result
    FROM (
             SELECT u.id AS user_id,
                    u.name,
                    u.email,
                    (SELECT get_daily_digest_recently_assigned(u.id)) AS recently_assigned,
                    (SELECT get_daily_digest_overdue(u.id)) AS overdue,
                    (SELECT get_daily_digest_recently_completed(u.id)) AS recently_completed
             FROM users u
             WHERE EXISTS(
                 SELECT 1
                 FROM notification_settings ns
                 INNER JOIN team_members tm ON tm.team_id = ns.team_id AND tm.user_id = u.id
                 WHERE ns.user_id = u.id
                   AND ns.daily_digest_enabled IS TRUE
             )
         ) rec;
    RETURN _result;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Sub-functions — add archived task/project filtering
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_daily_digest_overdue(_user_id uuid) RETURNS json
    LANGUAGE plpgsql
AS
$$
DECLARE
    _result JSON;
BEGIN
    SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(rec))), '[]'::JSON)
    INTO _result
    FROM (
             SELECT id,
                    name,
                    (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(r))), '[]'::JSON) AS projects
                     FROM (
                              SELECT id,
                                     name,
                                     (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(r))), '[]'::JSON) AS tasks
                                      FROM (
                                               SELECT t.id,
                                                      t.name,
                                                      (SELECT STRING_AGG(DISTINCT
                                                                         (SELECT name
                                                                          FROM team_member_info_view
                                                                          WHERE team_member_id = tasks_assignees.team_member_id),
                                                                         ', ')
                                                       FROM tasks_assignees
                                                       WHERE task_id = t.id) AS members
                                               FROM tasks_assignees
                                                        INNER JOIN tasks t ON tasks_assignees.task_id = t.id
                                                        INNER JOIN team_members tm ON tasks_assignees.team_member_id = tm.id
                                               WHERE tm.user_id = _user_id
                                                 AND t.project_id = projects.id
                                                 AND t.archived IS FALSE
                                                 AND t.end_date IS NOT NULL
                                                 AND t.end_date < CURRENT_DATE
                                                 AND EXISTS(SELECT id
                                                            FROM task_statuses
                                                            WHERE id = t.status_id
                                                              AND category_id IN
                                                                  (SELECT id FROM sys_task_status_categories WHERE is_done IS FALSE))
                                               LIMIT 10
                                           ) r)
                              FROM projects
                              WHERE projects.team_id IN
                                    (SELECT team_id
                                     FROM team_members
                                     WHERE user_id = _user_id
                                       AND team_members.team_id = teams.id)
                                AND NOT EXISTS(SELECT 1 FROM archived_projects WHERE project_id = projects.id AND user_id = _user_id)
                          ) r)
             FROM teams
             WHERE (SELECT daily_digest_enabled
                    FROM notification_settings
                    WHERE team_id = teams.id
                      AND user_id = _user_id) IS TRUE
               AND EXISTS(SELECT 1
                          FROM team_members
                          WHERE team_id = teams.id
                            AND team_members.user_id = _user_id)
         ) rec;
    RETURN _result;
END
$$;

CREATE OR REPLACE FUNCTION get_daily_digest_recently_assigned(_user_id uuid) RETURNS json
    LANGUAGE plpgsql
AS
$$
DECLARE
    _result JSON;
BEGIN
    SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(rec))), '[]'::JSON)
    INTO _result
    FROM (
             SELECT id,
                    name,
                    (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(r))), '[]'::JSON) AS projects
                     FROM (
                              SELECT id,
                                     name,
                                     (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(r))), '[]'::JSON) AS tasks
                                      FROM (
                                               SELECT t.id,
                                                      t.name,
                                                      (SELECT STRING_AGG(DISTINCT
                                                                         (SELECT name
                                                                          FROM team_member_info_view
                                                                          WHERE team_member_id = tasks_assignees.team_member_id),
                                                                         ', ')
                                                       FROM tasks_assignees
                                                       WHERE task_id = t.id) AS members
                                               FROM tasks_assignees
                                                        INNER JOIN tasks t ON tasks_assignees.task_id = t.id
                                                        INNER JOIN team_members tm ON tasks_assignees.team_member_id = tm.id
                                               WHERE tm.user_id = _user_id
                                                 AND t.project_id = projects.id
                                                 AND t.archived IS FALSE
                                                 AND TO_CHAR(tasks_assignees.created_at, 'yyyy-mm-dd') =
                                                     TO_CHAR(CURRENT_DATE, 'yyyy-mm-dd')
                                           ) r)
                              FROM projects
                              WHERE projects.team_id IN
                                    (SELECT team_id
                                     FROM team_members
                                     WHERE user_id = _user_id
                                       AND team_members.team_id = teams.id)
                                AND NOT EXISTS(SELECT 1 FROM archived_projects WHERE project_id = projects.id AND user_id = _user_id)
                          ) r)
             FROM teams
             WHERE (SELECT daily_digest_enabled
                    FROM notification_settings
                    WHERE team_id = teams.id
                      AND user_id = _user_id) IS TRUE
               AND EXISTS(SELECT 1
                          FROM team_members
                          WHERE team_id = teams.id
                            AND team_members.user_id = _user_id)
         ) rec;
    RETURN _result;
END
$$;

CREATE OR REPLACE FUNCTION get_daily_digest_recently_completed(_user_id uuid) RETURNS json
    LANGUAGE plpgsql
AS
$$
DECLARE
    _result JSON;
BEGIN
    SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(rec))), '[]'::JSON)
    INTO _result
    FROM (
             SELECT id,
                    name,
                    (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(r))), '[]'::JSON) AS projects
                     FROM (
                              SELECT name,
                                     (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(r))), '[]'::JSON) AS tasks
                                      FROM (
                                               SELECT t.id,
                                                      t.name,
                                                      (SELECT STRING_AGG(DISTINCT
                                                                         (SELECT name
                                                                          FROM team_member_info_view
                                                                          WHERE team_member_id = tasks_assignees.team_member_id),
                                                                         ', ')
                                                       FROM tasks_assignees
                                                       WHERE task_id = t.id) AS members
                                               FROM tasks_assignees
                                                        INNER JOIN tasks t ON tasks_assignees.task_id = t.id
                                                        INNER JOIN team_members tm ON tasks_assignees.team_member_id = tm.id
                                               WHERE tm.user_id = _user_id
                                                 AND t.project_id = projects.id
                                                 AND t.archived IS FALSE
                                                 AND t.completed_at IS NOT NULL
                                                 AND TO_CHAR(t.completed_at, 'yyyy-mm-dd') =
                                                     TO_CHAR(CURRENT_DATE, 'yyyy-mm-dd')
                                               LIMIT 10
                                           ) r)
                              FROM projects
                              WHERE projects.team_id IN
                                    (SELECT team_id
                                     FROM team_members
                                     WHERE user_id = _user_id
                                       AND team_members.team_id = teams.id)
                                AND NOT EXISTS(SELECT 1 FROM archived_projects WHERE project_id = projects.id AND user_id = _user_id)
                          ) r)
             FROM teams
             WHERE (SELECT daily_digest_enabled
                    FROM notification_settings
                    WHERE team_id = teams.id
                      AND user_id = _user_id) IS TRUE
               AND EXISTS(SELECT 1
                          FROM team_members
                          WHERE team_id = teams.id
                            AND team_members.user_id = _user_id)
         ) rec;
    RETURN _result;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. get_project_daily_digest() — subscriber validation + archived filtering
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_project_daily_digest() RETURNS json
    LANGUAGE plpgsql
AS
$$
DECLARE
    _result JSON;
BEGIN

    SELECT COALESCE(JSON_AGG(rec), '[]'::JSON)
    INTO _result
    FROM (SELECT id,
                 name,
                 (SELECT name FROM teams WHERE id = projects.team_id) AS team_name,

                 (SELECT COALESCE(JSON_AGG(rec), '[]'::JSON)
                  FROM (SELECT id,
                               name,
                               (SELECT STRING_AGG(DISTINCT
                                                  (SELECT name
                                                   FROM team_member_info_view
                                                   WHERE team_member_id = tasks_assignees.team_member_id),
                                                  ', ')
                                FROM tasks_assignees
                                WHERE task_id = tasks.id) AS members
                        FROM tasks
                        WHERE project_id = projects.id
                          AND tasks.archived IS FALSE
                          AND TO_CHAR(tasks.completed_at, 'yyyy-mm-dd') =
                              TO_CHAR(CURRENT_DATE, 'yyyy-mm-dd')) rec) AS today_completed,

                 (SELECT COALESCE(JSON_AGG(rec), '[]'::JSON)
                  FROM (SELECT id,
                               name,
                               (SELECT STRING_AGG(DISTINCT
                                                  (SELECT name
                                                   FROM team_member_info_view
                                                   WHERE team_member_id = tasks_assignees.team_member_id),
                                                  ', ')
                                FROM tasks_assignees
                                WHERE task_id = tasks.id) AS members
                        FROM tasks
                        WHERE project_id = projects.id
                          AND tasks.archived IS FALSE
                          AND TO_CHAR(tasks.created_at, 'yyyy-mm-dd') =
                              TO_CHAR(CURRENT_DATE, 'yyyy-mm-dd')) rec) AS today_new,

                 (SELECT COALESCE(JSON_AGG(rec), '[]'::JSON)
                  FROM (SELECT id,
                               name,
                               (SELECT STRING_AGG(DISTINCT
                                                  (SELECT name
                                                   FROM team_member_info_view
                                                   WHERE team_member_id = tasks_assignees.team_member_id),
                                                  ', ')
                                FROM tasks_assignees
                                WHERE task_id = tasks.id) AS members
                        FROM tasks
                        WHERE project_id = projects.id
                          AND tasks.archived IS FALSE
                          AND TO_CHAR(tasks.end_date, 'yyyy-mm-dd') =
                              TO_CHAR(CURRENT_DATE + INTERVAL '1 day', 'yyyy-mm-dd')) rec) AS due_tomorrow,

                 (SELECT COALESCE(JSON_AGG(rec), '[]'::JSON)
                  FROM (SELECT u.id AS user_id, u.name, u.email
                        FROM users u
                        WHERE u.id = (SELECT ps.user_id
                                      FROM project_subscribers ps
                                      WHERE ps.project_id = projects.id
                                        AND ps.user_id = u.id)
                          AND EXISTS(SELECT 1 FROM team_members tm
                                     WHERE tm.team_id = projects.team_id
                                       AND tm.user_id = u.id)
                          AND NOT EXISTS(SELECT 1 FROM archived_projects ap
                                         WHERE ap.project_id = projects.id
                                           AND ap.user_id = u.id)
                          AND EXISTS(SELECT 1 FROM notification_settings ns
                                     WHERE ns.user_id = u.id
                                       AND ns.team_id = projects.team_id
                                       AND ns.daily_digest_enabled IS TRUE)
                       ) rec) AS subscribers

          FROM projects
          WHERE EXISTS(SELECT 1 FROM project_subscribers WHERE project_id = projects.id)
          ORDER BY team_id, name) rec;

    RETURN _result;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. get_task_updates() — per-user marking, no global UPDATE, archived filter
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_task_updates() RETURNS json
    LANGUAGE plpgsql
AS
$$
DECLARE
    _result JSON;
BEGIN
    SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(rec))), '[]'::JSON)
    INTO _result
    FROM (SELECT users.id AS user_id,
                 name,
                 email,
                 (SELECT id
                  FROM team_members
                  WHERE team_id = users.active_team
                    AND user_id = users.id) AS team_member_id,
                 (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(r))), '[]'::JSON) AS teams
                  FROM (SELECT id,
                               name,
                               (SELECT team_member_id
                                FROM team_member_info_view
                                WHERE team_id = teams.id
                                  AND user_id = users.id) AS team_member_id,
                               (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(r))), '[]'::JSON) AS projects
                                FROM (SELECT id,
                                             name,
                                             (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(r))), '[]'::JSON) AS tasks
                                              FROM (SELECT t.id,
                                                           t.name AS name,
                                                           task_updates.id AS task_update_id,
                                                           (SELECT name FROM users WHERE id = task_updates.reporter_id) AS updater_name,
                                                           (SELECT STRING_AGG(DISTINCT
                                                                              (SELECT name
                                                                               FROM team_member_info_view
                                                                               WHERE team_member_id = tasks_assignees.team_member_id),
                                                                              ', ')
                                                            FROM tasks_assignees
                                                            WHERE task_id = task_updates.task_id) AS members
                                                    FROM task_updates
                                                             INNER JOIN tasks t ON task_updates.task_id = t.id
                                                    WHERE task_updates.user_id = users.id
                                                      AND task_updates.project_id = projects.id
                                                      AND task_updates.type = 'ASSIGN'
                                                      AND task_updates.is_sent IS FALSE
                                                      AND t.archived IS FALSE
                                                    ORDER BY task_updates.created_at) r)
                                      FROM projects
                                      WHERE team_id = teams.id
                                        AND NOT EXISTS(SELECT 1 FROM archived_projects WHERE project_id = projects.id AND user_id = users.id)
                                        AND EXISTS(SELECT 1
                                                   FROM task_updates
                                                   WHERE project_id = projects.id
                                                     AND user_id = users.id
                                                     AND type = 'ASSIGN'
                                                     AND is_sent IS FALSE)) r)
                        FROM teams
                        WHERE EXISTS(SELECT 1 FROM team_members WHERE team_id = teams.id AND user_id = users.id)
                          AND (SELECT email_notifications_enabled
                               FROM notification_settings
                               WHERE team_id = teams.id
                                 AND user_id = users.id) IS TRUE) r)
          FROM users
          WHERE EXISTS(SELECT 1 FROM task_updates WHERE user_id = users.id AND is_sent IS FALSE)) rec;

    -- NOTE: task_updates are NOT marked as sent here.
    -- The application layer marks them per-user after successful email delivery.

    RETURN _result;
END
$$;
