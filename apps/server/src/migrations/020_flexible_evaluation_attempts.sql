ALTER TABLE agent_platform.analysis_evaluation_batches
 DROP CONSTRAINT analysis_evaluation_batches_repetitions_check,
 ADD CONSTRAINT analysis_evaluation_batches_repetitions_check
 CHECK (repetitions BETWEEN 1 AND 100);
