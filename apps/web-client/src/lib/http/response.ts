export class HttpResponseError extends Error {
	constructor(
		public status: number,
		message: string,
		public code = 'request_failed',
		public retryAfterMs?: number,
	) {
		super(message);
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function retryDelay(
	value: string | null,
	now = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	const delay =
		Number.isFinite(seconds) && seconds >= 0
			? seconds * 1000
			: Date.parse(value) - now;
	return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

export function requestSignal(
	caller: AbortSignal | null | undefined,
	timeoutMs: number,
) {
	const controller = new AbortController();
	const abort = () => controller.abort(caller?.reason);
	if (caller?.aborted) abort();
	else caller?.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException(
					'Request timed out',
					'TimeoutError',
				),
			),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			caller?.removeEventListener('abort', abort);
		},
	};
}

export function isCancelled(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

export async function readJsonResponse(response: Response): Promise<unknown> {
	if (response.status === 413)
		throw new HttpResponseError(
			413,
			'The upload exceeds the hosting service’s request size limit. Try a smaller file or upload fewer files at once.',
			'payload_too_large',
		);
	if (
		!response.headers
			.get('content-type')
			?.toLowerCase()
			.includes('application/json')
	)
		throw new HttpResponseError(
			503,
			'The server returned an invalid response. Please try again.',
			'invalid_response',
			retryDelay(response.headers.get('retry-after')),
		);
	try {
		return await response.json();
	} catch (error) {
		if (isCancelled(error)) throw error;
		throw new HttpResponseError(
			503,
			'The server returned an invalid response. Please try again.',
			'invalid_response',
			retryDelay(response.headers.get('retry-after')),
		);
	}
}

/** Runtime checks for envelopes used by critical execution and catalog views. */
export function assertProjectPayload(
	path: string,
	value: unknown,
	method = 'GET',
): asserts value is Record<string, unknown> {
	const invalid = () => {
		throw new HttpResponseError(
			503,
			'The server returned an invalid response. Please try again.',
			'invalid_response',
		);
	};
	if (!isRecord(value)) return invalid();
	const url = new URL(path || '/', 'https://contracts.invalid');
	const route = url.pathname;
	const positive = (v: unknown) => Number.isInteger(v) && Number(v) > 0;
	const text = (v: unknown) => typeof v === 'string' && v.length > 0;

	const toolSelection = (v: unknown) => v === undefined || v === null || (isRecord(v) && typeof v.accuracy === 'number' && Number.isFinite(v.accuracy) && v.accuracy >= 0 && v.accuracy <= 100 && ['required', 'used', 'matched', 'missing', 'unexpected'].every(k => Array.isArray(v[k]) && (v[k] as unknown[]).every(text)));

	if (route.endsWith('/answer-evaluation')) {
		if (value.evaluation === null) return;
		const e = value.evaluation;
		if (!isRecord(e) || !['pending', 'scored'].includes(String(e.state)) || !isRecord(e.expected) || !isRecord(e.summary) || !(e.result === null || (isRecord(e.result) && typeof e.result.success === 'boolean' && isRecord(e.result.fields) && toolSelection(e.result.tool_selection)))) return invalid();
		return;
	}

	if (route.includes('/analysis-evaluations')) {
		const statuses = ['running', 'cancelling', 'completed', 'cancelled'];
		if (method === 'POST') { if (!text(value.id)) return invalid(); return; }
		if (/\/analysis-evaluations$/.test(route)) {
			if (!Array.isArray(value.items) || !value.items.every(item => isRecord(item) && text(item.id) && text(item.name) && statuses.includes(String(item.status))) || !(value.next_offset === null || (Number.isSafeInteger(value.next_offset) && Number(value.next_offset) >= 0))) return invalid();
			return;
		}
		const score = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100);
		const duration = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
		if (!text(value.id) || !text(value.name) || !statuses.includes(String(value.status)) || !isRecord(value.dataset) || !text(value.dataset.name) || !isRecord(value.suite) || !Array.isArray(value.suite.cases) || !value.suite.cases.every(c => isRecord(c) && text(c.id) && text(c.question) && isRecord(c.expected)) || !Array.isArray(value.attempts) || !isRecord(value.summary)) return invalid();
		if (!['answer_correctness', 'task_success_rate'].every(k => score(value.summary && (value.summary as Record<string, unknown>)[k])) || !['median_latency_ms', 'p95_latency_ms'].every(k => duration((value.summary as Record<string, unknown>)[k])) || !(value.summary.pass_k === null || (isRecord(value.summary.pass_k) && Object.values(value.summary.pass_k).every(score)))) return invalid();
		for (const a of value.attempts) {
			if (!isRecord(a) || !text(a.id) || !text(a.case_id) || !positive(a.attempt) || !duration(a.latency_ms) || !(a.result === null || (isRecord(a.result) && typeof a.result.success === 'boolean' && isRecord(a.result.fields) && toolSelection(a.result.tool_selection) && (a.result.parsed === null || (isRecord(a.result.parsed) && typeof a.result.parsed.final_answer === 'string' && isRecord(a.result.parsed.answers)))))) return invalid();
		}
		return;
	}

	if (route.endsWith('/usage')) {
		const totals = (entry: unknown) =>
			isRecord(entry) &&
			[
				'input_tokens',
				'output_tokens',
				'total_tokens',
				'calls',
				'missing_usage_calls',
				'unpriced_calls',
			].every(
				key =>
					Number.isSafeInteger(entry[key]) &&
					Number(entry[key]) >= 0,
			) &&
			(typeof entry.estimated_cost_usd === 'string' ||
				typeof entry.estimated_cost_usd === 'number') &&
			Number.isFinite(Number(entry.estimated_cost_usd)) &&
			Number(entry.estimated_cost_usd) >= 0;
		if (
			value.currency !== 'USD' ||
			!text(value.pricing_date) ||
			!totals(value.totals) ||
			!isRecord(value.sources) ||
			!totals(value.sources.agent) ||
			!totals(value.sources.evaluation) ||
			!Array.isArray(value.daily) ||
			value.daily.length !== 14 ||
			!value.daily.every(
				day =>
					totals(day) &&
					isRecord(day) &&
					typeof day.date === 'string' &&
					/^\d{4}-\d{2}-\d{2}$/.test(day.date),
			)
		)
			return invalid();
		return;
	}
	if (route.endsWith('/benchmarks/performance') && method === 'GET') {
		const count = (n: unknown) =>
			Number.isSafeInteger(n) && Number(n) >= 0;
		const percentage = (n: unknown) =>
			n === null ||
			(typeof n === 'number' &&
				Number.isFinite(n) &&
				n >= 0 &&
				n <= 100);
		if (
			!Array.isArray(value.items) ||
			!value.items.every(
				item =>
					isRecord(item) &&
					text(item.agent_id) &&
					text(item.agent_name) &&
					count(item.runs) &&
					count(item.questions) &&
					count(item.completed) &&
					[
						'precision',
						'recall',
						'argument_accuracy',
						'completion_rate',
					].every(key => percentage(item[key])) &&
					(item.latency_ms === null ||
						(typeof item.latency_ms ===
							'number' &&
							Number.isFinite(
								item.latency_ms,
							) &&
							item.latency_ms >= 0)),
			)
		)
			return invalid();
		return;
	}
    if (/\/executions\/[^/]+\/metrics$/.test(route)) {
        const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
        const percentage = (n: unknown) => n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100);
        const tool = (entry: unknown) => isRecord(entry) && text(entry.tool_key) && text(entry.name) && isRecord(entry.input_schema);
        if (!['pending', 'scored', 'needs_reference'].includes(String(value.state)) ||
            !['question', 'benchmark'].includes(String(value.source)) ||
            !Array.isArray(value.tools) || !value.tools.every(tool) ||
            !(value.expected_steps === null || (Array.isArray(value.expected_steps) && value.expected_steps.every(step => tool(step) && isRecord(step) && isRecord(step.arguments)))) ||
            !(value.latency_ms === null || (typeof value.latency_ms === 'number' && Number.isFinite(value.latency_ms) && value.latency_ms >= 0)) ||
            !(value.metrics === null || (isRecord(value.metrics) &&
                ['precision', 'recall', 'argument_accuracy'].every(key => percentage((value.metrics as Record<string, unknown>)[key])) &&
                ['actual_calls', 'expected_calls', 'matched_calls'].every(key => count((value.metrics as Record<string, unknown>)[key]))))
        ) return invalid();
        return;
    }
	const catalog =
		/\/(tools|prompts|spans|evaluations)$/.test(route) &&
		method === 'GET';
	if (catalog && !('items' in value)) return invalid();
	if ('items' in value) {
		if (
			!Array.isArray(value.items) ||
			!value.items.every(
				item => isRecord(item) && text(item.id),
			)
		)
			return invalid();
		if (
			'next_offset' in value &&
			value.next_offset !== null &&
			(!Number.isInteger(value.next_offset) ||
				Number(value.next_offset) < 0)
		)
			return invalid();
		if (/\/(tools|prompts)$/.test(route) && method === 'GET') {
			if (!('next_offset' in value)) return invalid();
			for (const item of value.items) {
				if (
					!isRecord(item) ||
					!text(item.name) ||
					!positive(item.revision)
				)
					return invalid();
				if (
					route.endsWith('/tools') &&
					(!text(item.server_id) ||
						typeof item.enabled !==
							'boolean' ||
						typeof item.available !==
							'boolean')
				)
					return invalid();
			}
		}
		if (
			route.endsWith('/spans') &&
			!value.items.every(
				item =>
					isRecord(item) &&
					['model', 'tool'].includes(
						String(item.kind),
					) &&
					positive(item.sequence) &&
					typeof item.name === 'string' &&
					typeof item.status === 'string' &&
					Array.isArray(item.context_span_ids),
			)
		)
			return invalid();
		if (route.endsWith('/evaluations')) {
			if (!('next_offset' in value)) return invalid();
			const finding = (item: unknown) =>
				isRecord(item) &&
				text(item.name) &&
				text(item.reason) &&
				Array.isArray(item.evidence_refs) &&
				item.evidence_refs.every(
					ref => typeof ref === 'string',
				);
			for (const item of value.items) {
				if (
					!isRecord(item) ||
					!positive(item.attempt) ||
					![
						'queued',
						'running',
						'completed',
						'failed',
					].includes(String(item.status)) ||
					!isRecord(item.profile) ||
					!text(item.profile.model) ||
					!positive(item.profile.rubric_version)
				)
					return invalid();
				if (
					item.report !== null &&
					(!isRecord(item.report) ||
						!text(
							item.report
								.task_outcome,
						) ||
						!text(
							item.report
								.overall_verdict,
						) ||
						![
							'checks',
							'requirements',
							'critical_failures',
						].every(
							key =>
								Array.isArray(
									item.report &&
										(
											item.report as Record<
												string,
												unknown
											>
										)[
											key
										],
								) &&
								(
									(
										item.report as Record<
											string,
											unknown
										>
									)[
										key
									] as unknown[]
								).every(
									finding,
								),
						) ||
						!Array.isArray(
							item.report.limitations,
						) ||
						!item.report.limitations.every(
							text,
						))
				)
					return invalid();
				if (
					item.metrics !== null &&
					(!isRecord(item.metrics) ||
						!isRecord(
							item.metrics
								.usage_counts,
						) ||
						!Array.isArray(
							item.metrics.assertions,
						))
				)
					return invalid();
			}
		}
		return;
	}
	if (/\/executions\/[^/]+(?:\/cancel)?$/.test(route)) {
		if (
			!text(value.id) ||
			![
				'queued',
				'running',
				'completed',
				'failed',
				'cancelled',
				'interrupted',
			].includes(String(value.status))
		)
			return invalid();
		if (
			!('final_answer' in value) ||
			(value.final_answer !== null &&
				typeof value.final_answer !== 'string')
		)
			return invalid();
		if (
			url.searchParams.get('view') !== 'status' &&
			typeof value.input !== 'string'
		)
			return invalid();
		if ('spans' in value && !Array.isArray(value.spans))
			return invalid();
		if (
			url.searchParams.has('view') &&
			(!Number.isInteger(value.model_turns) ||
				Number(value.model_turns) < 0 ||
				!Number.isInteger(value.tool_calls) ||
				Number(value.tool_calls) < 0 ||
				(value.failure_hint !== null &&
					typeof value.failure_hint !== 'string'))
		)
			return invalid();
	} else if (
		/\/agents\/[^/]+\/executions$/.test(route) &&
		method === 'POST'
	) {
		if (!text(value.id) || !text(value.status)) return invalid();
	} else if (
		(/\/tools\/[^/]+\/executions$/.test(route) &&
			method === 'POST') ||
		/\/tools\/[^/]+\/executions\/requests\/[^/]+$/.test(route)
	) {
		if (
			!text(value.id) ||
			!positive(value.revision) ||
			![
				'running',
				'success',
				'tool_error',
				'unknown',
			].includes(String(value.status))
		)
			return invalid();
	} else if (/\/spans\/[^/]+$/.test(route)) {
		if (
			!text(value.id) ||
			!('inputs' in value) ||
			!('outputs' in value)
		)
			return invalid();
	}
}
