-- Human-defined expected calls, shared by exact question and dataset contents.
CREATE TABLE agent_platform.execution_metric_references (
 project_id uuid NOT NULL REFERENCES agent_platform.projects(id) ON DELETE CASCADE,
 question_key text NOT NULL,
 calls jsonb NOT NULL,
 updated_by uuid NOT NULL REFERENCES agent_platform.users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,question_key)
);

DO $$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='agent_platform_api') THEN
  GRANT SELECT,INSERT,UPDATE ON agent_platform.execution_metric_references TO agent_platform_api;
 END IF;
END $$;
