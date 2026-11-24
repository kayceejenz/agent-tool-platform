CREATE TABLE agent_platform.analysis_evaluation_batches (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES agent_platform.projects(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL REFERENCES agent_platform.agents(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES agent_platform.users(id),
 request_id uuid NOT NULL,
 request_hash text NOT NULL,
 agent_revision integer NOT NULL,
 repetitions integer NOT NULL CHECK (repetitions IN (1,5)),
 suite jsonb NOT NULL,
 snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','cancelling','completed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,user_id,request_id)
);
CREATE TABLE agent_platform.analysis_evaluation_attempts (
 id uuid PRIMARY KEY,
 batch_id uuid NOT NULL REFERENCES agent_platform.analysis_evaluation_batches(id) ON DELETE CASCADE,
 case_id text NOT NULL,
 position integer NOT NULL,
 attempt integer NOT NULL,
 execution_id uuid REFERENCES agent_platform.agent_executions(id),
 result jsonb,
 UNIQUE(batch_id,case_id,attempt)
);
CREATE INDEX analysis_evaluation_active ON agent_platform.analysis_evaluation_batches(updated_at) WHERE status IN ('running','cancelling');
DO $$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='agent_platform_api') THEN
  GRANT SELECT,INSERT,UPDATE ON agent_platform.analysis_evaluation_batches,agent_platform.analysis_evaluation_attempts TO agent_platform_api;
 END IF;
END $$;
