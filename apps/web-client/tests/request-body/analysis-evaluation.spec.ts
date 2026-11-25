import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';

const origin = 'http://127.0.0.1:3102';
const projectId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const datasetId = '44444444-4444-4444-8444-444444444444';
const batchId = '55555555-5555-4555-8555-555555555555';
const now = '2026-11-24T12:00:00Z';
const suite = { name: 'Pig trial test', cases: [{ id: 'PIG-001', question: 'Count rows', expected: { event_count: 42 }, comparison: { event_count: { type: 'exact' } } }] };
let created = false, role = 'owner', malformed = false, posts = 0, singleRun = false, requestedAttempts = 0;
const agent = { id: agentId, name: 'Dataset analyst', description: '', revision: 1, current_revision: 1, enabled: true, tool_count: 0,
	model_settings: { provider: 'openai', model: 'fixture', temperature: null }, created_at: now,
	system_prompt: null, agent_prompt: null, evaluation_prompt: null, evaluation_profile: { enabled: false, prompt: null, model: null },
	tools: [], limits: { max_turns: 8, max_tool_calls: 8, timeout_seconds: 60, max_output_tokens: 2048 }, configuration_ready: true, configuration_issues: [] };
function batch() {
	return { id: batchId, name: suite.name, status: 'completed', agent_revision: 1, repetitions: 1, suite, dataset: { id: datasetId, name: 'Synthetic pig trial' },
		summary: { finished: 1, total: 1, timed_attempts: 1, answer_correctness: malformed ? 0 : 100, task_success_rate: malformed ? 0 : 100, pass_k: { '1': malformed ? 0 : 100 }, median_latency_ms: 1200, p95_latency_ms: 1200 },
		attempts: [{ id: runId, case_id: 'PIG-001', attempt: 1, execution_id: runId, execution_status: 'completed', termination_reason: 'final_answer', latency_ms: 1200,
			raw_answer: malformed ? 'My unstructured answer is 42 rows.' : JSON.stringify({ final_answer: 'The dataset contains **42 rows**.', answers: { event_count: 42 } }),
			result: { success: !malformed, error: malformed ? 'invalid_answer_format' : null, parsed: malformed ? null : { final_answer: 'The dataset contains **42 rows**.', answers: { event_count: 42 } }, fields: { event_count: { correct: !malformed, present: !malformed, actual: malformed ? null : 42 } } } }] };
}
const backend = createServer(async (request, response) => {
	const path = new URL(request.url!, 'http://mock.invalid').pathname;
	const send = (v: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(v)); };
	if (path.endsWith('/auth/me')) return send({ id: datasetId, email: 'test@example.com', display_name: 'Test' });
	const project = { id: projectId, name: 'Dataset evaluation', description: null, role, created_by: datasetId, created_at: now, updated_at: now };
	if (path === '/api/v1/projects') return send({ items: [project], next_cursor: null });
	if (path.endsWith(`/projects/${projectId}`)) return send(project);
	if (path.endsWith('/agents')) return send({ items: [agent], next_offset: null });
	if (path.endsWith(`/agents/${agentId}`)) return send(agent);
	if (path.endsWith('/datasets')) return send({ items: [{ id: datasetId, name: 'Synthetic pig trial', created_at: now, file_count: 1 }], next_offset: null });
	if (path.endsWith(`/agents/${agentId}/executions`)) {
		if (request.method === 'POST') {
			let body = ''; for await (const chunk of request) body += chunk;
			const payload = JSON.parse(body);
			expect(payload.input).toBe('Count rows');
			expect(payload.answer_reference).toEqual({ expected: { event_count: 42 }, comparison: { event_count: { type: 'exact' } }, required_tools: ['read_file', 'execute_python'] });
			expect(payload.answer_reference.question).toBeUndefined();
			singleRun = true; posts++; return send({ id: runId, status: 'completed' }, 202);
		}
		return send({ items: [], next_offset: null });
	}
	if (path.endsWith(`/executions/${runId}`)) return send({ id: runId, input: 'Count rows', agent_revision: 1, status: 'completed', termination_reason: 'final_answer', created_at: now, finished_at: now, final_answer: JSON.stringify({ final_answer: 'The dataset contains **42 rows**.', answers: { event_count: 42 } }), model_turns: 1, tool_calls: 1, failure_hint: null, analysis_dataset_id: datasetId });
	if (path.endsWith('/answer-evaluation')) return send({ evaluation: singleRun ? { state: 'scored', expected: { event_count: 42 }, result: { ...batch().attempts[0].result, tool_selection: { accuracy: 100, required: ['read_file', 'execute_python'], used: ['read_file', 'execute_python'], matched: ['read_file', 'execute_python'], missing: [], unexpected: [] } }, repetitions: 1, latency_ms: 1200, summary: { pass_k: { '1': 100 } } } : null });

	if (path.endsWith('/analysis-evaluations') && request.method === 'POST') {
		let body = ''; for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body); expect(payload.suite).toEqual(suite); expect(payload.dataset_id).toBe(datasetId);
		requestedAttempts = payload.attempts; posts++; created = true; return send({ id: batchId }, 202);
	}
	if (path.endsWith('/analysis-evaluations')) return send({ items: created ? [{ id: batchId, name: suite.name, status: 'completed' }] : [], next_offset: null });
	if (path.endsWith('/analysis-evaluations/'+batchId)) return send(batch());
	if (path.endsWith('/spans')) return send({ items: [], next_offset: null });
	if (path.endsWith('/snapshot')) return send({});
	if (path.endsWith('/artifacts')) return send({ items: [], warnings: [], expires_at: now });
	return send({ items: [], next_offset: null });
});
test.beforeAll(async () => { await new Promise<void>((resolve, reject) => { backend.once('error', reject); backend.listen(3103, '127.0.0.1', resolve); }); });
test.afterAll(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); });
test.beforeEach(async ({ context }) => { created = false; role = 'owner'; malformed = false; posts = 0; singleRun = false; await context.addCookies([{ name: 'agent_access_token', value: 'fixture', url: origin, httpOnly: true }]); });

test('upload suite, evaluate, inspect readable answer and retain results after refresh', async ({ page }) => {
	await page.goto(`/projects/${projectId}/agents/${agentId}/playground`);
	await expect(page.getByRole('button', { name: 'Inspect', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Evaluate', exact: true }).click();
	const panel = page.getByRole('region', { name: 'Dataset evaluation', exact: true });
	await panel.getByLabel('Dataset', { exact: true }).selectOption(datasetId);
	await panel.getByLabel('Test suite JSON').setInputFiles({ name: 'suite.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(suite)) });
	await expect(panel).toContainText('1 question · 1 attempt');
	await panel.getByRole('button', { name: 'Run evaluation', exact: true }).click();
	await expect(panel).toContainText('1 of 1 attempts scored');
	await panel.getByRole('button', { name: 'Inspect PIG-001 attempt 1', exact: true }).click();
	const details = panel.getByRole('region', { name: 'Evaluation attempt details' });
	await expect(details).toContainText('The dataset contains 42 rows.');
	await expect(details.getByRole('definition')).toHaveText(['100.0%', '100%', '1.20 s']);
	await expect(panel.getByLabel('Test suite JSON')).toHaveCount(0);
	await expect(panel.getByLabel('Saved evaluations')).toHaveCount(0);
	await expect(details.getByRole('heading', { name: 'PIG-001', exact: true })).toBeFocused();
	await page.screenshot({ path: 'test-results/evaluation-inspect-desktop.png', fullPage: true });
	await details.getByRole('button', { name: 'All results', exact: true }).click();
	await expect(panel.getByRole('button', { name: 'Inspect PIG-001 attempt 1', exact: true })).toBeFocused();
	await expect(panel.getByLabel('Evaluation summary').getByRole('definition')).toHaveText(['100.0%', '100.0%', '100.0%', '1.20 s', '1.20 s']);
	expect(posts).toBe(1);
	await page.reload(); await page.getByRole('button', { name: 'Evaluate', exact: true }).click();
	await expect(panel).toContainText('1 of 1 attempts scored');
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: 'test-results/analysis-evaluation-mobile.png', fullPage: true });
	await panel.getByRole('button', { name: 'Inspect PIG-001 attempt 1', exact: true }).click();
	await expect(details).toContainText('The dataset contains 42 rows.');
	await expect(details.getByRole('button', { name: 'Previous attempt' })).toBeDisabled();
	await expect(details.getByRole('button', { name: 'Next attempt' })).toBeDisabled();
	await page.screenshot({ path: 'test-results/evaluation-inspect-mobile.png', fullPage: true });
});

test('malformed responses remain readable and viewers cannot start evaluations', async ({ page }) => {
	created = true; role = 'viewer'; malformed = true;
	await page.goto(`/projects/${projectId}/agents/${agentId}/playground`);
	await page.getByRole('button', { name: 'Evaluate', exact: true }).click();
	const panel = page.getByRole('region', { name: 'Dataset evaluation', exact: true });
	await expect(panel.getByRole('button', { name: 'Run evaluation', exact: true })).toHaveCount(0);
	await panel.getByRole('button', { name: 'Inspect PIG-001 attempt 1', exact: true }).click();
	await expect(panel).toContainText('Invalid evaluation format');
	await expect(panel.getByRole('region', { name: 'Evaluation attempt details' })).toContainText('My unstructured answer is 42 rows.');
	expect(posts).toBe(0);
});


test('Run accepts pasted answer JSON without a question and hides legacy tool scores', async ({ page }) => {
	await page.goto(`/projects/${projectId}/agents/${agentId}/playground`);
	await expect(page.getByLabel('Dataset', { exact: true })).toHaveValue(datasetId);
	await expect(page.getByLabel('Dataset', { exact: true }).locator('option')).toHaveCount(1);
	await page.getByLabel('Task', { exact: true }).fill('Count rows');
	await page.getByLabel('Expected answer JSON', { exact: true }).fill('{"answers":{"event_count":42},"required_tools":["read_file","execute_python"]}');
	await page.getByRole('button', { name: 'Run task', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Execution stack' })).toContainText('The dataset contains 42 rows.');
	const evaluation = page.getByRole('region', { name: 'Answer evaluation', exact: true });
	await expect(evaluation).toContainText('100.0%');
	await expect(evaluation.getByRole('definition')).toHaveText(['100.0%', '100%', '100.0%', '100.0%', '1.20 s']);
	await expect(evaluation).toContainText('Tool selection accuracy');
	await expect(evaluation.getByLabel('Tool selection comparison')).toContainText('read_file, execute_python');
	await expect(page.getByText('Define expected steps', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Tool precision', { exact: true })).toHaveCount(0);
	expect(posts).toBe(1);
	await page.reload();
	await expect(evaluation).toContainText('100.0%');
	await page.screenshot({ path: 'test-results/run-answer-evaluation.png', fullPage: true });
});


test('accept custom attempts and reject invalid numeric values', async ({ page }) => {
    await page.goto(`/projects/${projectId}/agents/${agentId}/playground`);
    await page.getByRole('button', { name: 'Evaluate', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Dataset evaluation', exact: true });
    await panel.getByLabel('Test suite JSON').setInputFiles({ name: 'suite.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(suite)) });
    const input = panel.getByRole('spinbutton', { name: 'Attempts per question' });
    for (const value of ['', '0', '1.5', '101']) {
        await input.fill(value);
        await panel.getByRole('button', { name: 'Run evaluation', exact: true }).click();
        expect(posts).toBe(0);
    }
    await input.fill('3');
    await expect(panel).toContainText('1 question · 3 attempts');
    await panel.getByRole('button', { name: 'Run evaluation', exact: true }).click();
    await expect(panel).toContainText('1 of 1 attempts scored');
    expect(requestedAttempts).toBe(3);
});
