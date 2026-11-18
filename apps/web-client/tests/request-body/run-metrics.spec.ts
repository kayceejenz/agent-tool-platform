import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';

const origin = 'http://127.0.0.1:3102';
const projectId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const now = '2026-11-18T12:00:00Z';
const tools = [
    { tool_key: 'workspace_list_files', name: 'Workspace / list_files', input_schema: { type: 'object', properties: {} } },
    { tool_key: 'workspace_execute_python', name: 'Workspace / execute_python', input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
];
type Step = typeof tools[number] & { arguments: Record<string, unknown> };
let reference: Step[] | null = null;
let writes = 0, judgeRequests = 0;
let role = 'owner';
const agent = { id: agentId, name: 'Dataset analyst', description: '', revision: 1, current_revision: 1, enabled: true, tool_count: 0,
    model_settings: { provider: 'openai', model: 'fixture', temperature: null }, created_at: now,
    system_prompt: null, agent_prompt: null, evaluation_prompt: null, evaluation_profile: { enabled: true, prompt: null, model: null },
    tools: [], limits: { max_turns: 8, max_tool_calls: 8, timeout_seconds: 60, max_output_tokens: 2048 }, configuration_ready: true, configuration_issues: [],
};
const run = { id: runId, agent_revision: 1, input: 'Count dataset rows.', status: 'completed', termination_reason: 'final_answer',
    final_answer: 'There are 42 rows.', created_at: now, finished_at: now, model_turns: 3, tool_calls: 3, failure_hint: null, analysis_dataset_id: userId,
};
const backend = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://mock.invalid').pathname;
    const send = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path.endsWith('/auth/me')) return send({ id: userId, email: 'test@example.com', display_name: 'Test' });
    const project = { id: projectId, name: 'Dataset evaluation', description: null, role, created_by: userId, created_at: now, updated_at: now };
    if (path === '/api/v1/projects') return send({ items: [project], next_cursor: null });
    if (path.endsWith(`/projects/${projectId}`)) return send(project);
    if (path.endsWith('/agents')) return send({ items: [agent], next_offset: null });
    if (path.endsWith(`/agents/${agentId}`)) return send(agent);
    if (path.endsWith(`/agents/${agentId}/executions`)) return send({ items: [run], next_offset: null });
    if (path.endsWith(`/executions/${runId}`)) return send(run);
    if (path.endsWith('/artifacts')) return send({ items: [], warnings: [], expires_at: now });
    if (path.endsWith('/evaluations')) { judgeRequests++; return send({ items: [], next_offset: null }); }
    if (path.endsWith('/metrics')) {
        if (request.method === 'POST') {
            let body = '';
            for await (const chunk of request) body += chunk;
            const parsed = JSON.parse(body);
            writes++;
            expect(parsed.steps).toEqual([{ tool_key: 'workspace_list_files', arguments: {} }, { tool_key: 'workspace_execute_python', arguments: { code: 'print(42)' } }]);
            reference = parsed.steps.map((step: { tool_key: string; arguments: Record<string, unknown> }) => ({ ...tools.find(tool => tool.tool_key === step.tool_key)!, arguments: step.arguments }));
        }
        return send({ state: reference ? 'scored' : 'needs_reference', source: 'question', tools, expected_steps: reference, latency_ms: 1250,
            metrics: reference ? { precision: 200 / 3, recall: 100, argument_accuracy: 50, expected_calls: 2, actual_calls: 3, matched_calls: 2 } : null,
        });
    }
    return send({ items: [], next_offset: null });
});

test.beforeAll(async () => { await new Promise<void>((resolve, reject) => { backend.once('error', reject); backend.listen(3103, '127.0.0.1', resolve); }); });
test.afterAll(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); });
test.beforeEach(async ({ context }) => {
    reference = null; writes = 0; judgeRequests = 0; role = 'owner';
    await context.addCookies([{ name: 'agent_access_token', value: 'fixture', url: origin, httpOnly: true }]);
});

test('dataset run defines expected steps, shows calculated metrics and retains them on refresh', async ({ page }) => {
    await page.goto(`/projects/${projectId}/agents/${agentId}/playground?execution=${runId}`);
    const evaluation = page.getByRole('region', { name: 'Run evaluation' });
    await expect(evaluation).toContainText('Save expected steps');
    await expect(page.locator('.evaluation-panel')).toHaveCount(0);
    await evaluation.getByRole('button', { name: 'Define expected steps' }).click();
    await expect(evaluation.getByRole('button', { name: 'Save expected steps' })).toBeDisabled();
    await evaluation.getByLabel('Step 1 expected arguments').fill('[]');
    await evaluation.getByRole('checkbox').check();
    await evaluation.getByRole('button', { name: 'Save expected steps' }).click();
    await expect(evaluation.getByRole('alert')).toContainText('JSON object');
    expect(writes).toBe(0);
    await evaluation.getByLabel('Step 1 expected arguments').fill('{}');
    await evaluation.getByRole('button', { name: 'Add step' }).click();
    await evaluation.getByLabel('Step 2 tool').selectOption('workspace_execute_python');
    await evaluation.getByLabel('Step 2 expected arguments').fill('print(42)');
    await evaluation.getByRole('button', { name: 'Save expected steps' }).click();
    await expect(evaluation.getByRole('definition')).toHaveText(['66.7%', '100.0%', '50.0%', '1.25 s']);
    expect(writes).toBe(1);
    await evaluation.getByRole('button', { name: 'About argument accuracy' }).focus();
    await expect(evaluation.getByRole('tooltip')).toContainText('Python code is compared as text');
    await page.reload();
    await expect(evaluation.getByRole('definition')).toHaveText(['66.7%', '100.0%', '50.0%', '1.25 s']);
    expect(judgeRequests).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/run-metrics-mobile.png', fullPage: true });
});

test('viewer can read scores and agent settings hide all LLM judge controls', async ({ page }) => {
    role = 'viewer';
    reference = [{ ...tools[0], arguments: {} }];
    await page.goto(`/projects/${projectId}/agents/${agentId}/playground?execution=${runId}`);
    const evaluation = page.getByRole('region', { name: 'Run evaluation' });
    await expect(evaluation).toContainText('66.7%');
    await expect(evaluation.getByRole('button', { name: /expected steps/ })).toHaveCount(0);
    expect(writes).toBe(0);
    await page.goto(`/projects/${projectId}/agents/${agentId}`);
    await expect(page.getByRole('heading', { name: 'Dataset analyst', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Evaluation', exact: true })).toHaveCount(0);
    await expect(page.getByText('Evaluation settings', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Automatic evaluation', { exact: true })).toHaveCount(0);
    expect(judgeRequests).toBe(0);
});
