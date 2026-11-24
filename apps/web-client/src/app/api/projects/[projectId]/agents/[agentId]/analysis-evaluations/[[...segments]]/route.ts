import { json } from '@/lib/auth/server';
import { projectApi } from '@/lib/projects/server';
import { readRouteJson, routeError, uuidPattern } from '@/lib/http/project-route';
import { BODY_LIMITS } from '@/lib/http/request-body';

type Context = { params: Promise<{ projectId: string; agentId: string; segments?: string[] }> };
async function route(request: Request, context: Context) {
	const { projectId, agentId, segments = [] } = await context.params;
	const valid = !segments.length || (segments.length === 1 && uuidPattern.test(segments[0]) && request.method === 'GET') || (segments.length === 2 && uuidPattern.test(segments[0]) && segments[1] === 'cancel' && request.method === 'POST');
	if (!uuidPattern.test(projectId) || !uuidPattern.test(agentId) || !valid)
		return json({ error: 'Evaluation not found.' }, 404);
	try {
		const init: RequestInit = { method: request.method };
		if (request.method === 'POST') init.body = await readRouteJson(request, BODY_LIMITS.configuration, 'Send the evaluation suite as JSON.');
		const offset = new URL(request.url).searchParams.get('offset') ?? '0';
		if (!/^\d{1,6}$/.test(offset)) return json({ error: 'Invalid offset.' }, 400);
		return json(await projectApi(`/${projectId}/agents/${agentId}/analysis-evaluations${segments.length ? '/' + segments.join('/') : ''}?offset=${offset}`, init, {
			403: 'Your role cannot start or cancel evaluations.',
			404: 'Evaluation or dataset not found in this project.',
			409: 'Finish the active evaluation and check the agent revision before starting again.',
			422: 'Check the suite: unique case IDs, expected answers and a comparison rule for every field. Remove any answer-key files from the dataset.',
		}), request.method === 'POST' ? 202 : 200);
	} catch (error) { return routeError(error, 'Evaluation request failed. Please retry.'); }
}
export const GET = route;
export const POST = route;
