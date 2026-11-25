export type EvaluationCase = {
	id: string;
	question: string;
	expected: Record<string, unknown>;
	comparison: Record<string, unknown>;
	required_tools?: string[];
};
export type EvaluationSuite = { name: string; cases: EvaluationCase[] };
export type EvaluationAttempt = {
	id: string;
	case_id: string;
	attempt: number;
	execution_id: string | null;
	execution_status: string | null;
	raw_answer: string | null;
	termination_reason: string | null;
	latency_ms: number | null;
	result: null | {
		error: string | null;
		success: boolean;
		parsed: null | { final_answer: string; answers: Record<string, unknown> };
		tool_selection?: {
			accuracy: number;
			required: string[];
			used: string[];
			missing: string[];
			unexpected: string[];
		} | null;
		fields: Record<string, { correct: boolean; present: boolean; actual: unknown }>;
	};
};
export type EvaluationBatch = {
	id: string;
	name: string;
	status: string;
	agent_revision: number;
	repetitions: number;
	suite: EvaluationSuite;
	dataset: { name: string };
	attempts: EvaluationAttempt[];
	summary: {
		finished: number;
		total: number;
		timed_attempts: number;
		answer_correctness: number | null;
		tool_selection_accuracy?: number | null;
		tool_scored_attempts?: number;
		task_success_rate: number | null;
		pass_k: Record<string, number> | null;
		median_latency_ms: number | null;
		p95_latency_ms: number | null;
	};
};
export type EvaluationHistory = {
	items: { id: string; name: string; status: string; created_at?: string }[];
	next_offset: number | null;
};
