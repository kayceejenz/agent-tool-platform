import { json } from '@/lib/auth/server';
import { projectApi } from '@/lib/projects/server';
import {
	readRouteJson,
	routeError,
	uuidPattern,
} from '@/lib/http/project-route';
import { BODY_LIMITS } from '@/lib/http/request-body';

type Context = { params: Promise<{ projectId: string; executionId: string }> };
async function route(request: Request, context: Context) {
	const { projectId, executionId } = await context.params;
	if (!uuidPattern.test(projectId) || !uuidPattern.test(executionId))
		return json({ error: 'Run not found.' }, 404);
	try {
		const init: RequestInit = { method: request.method };
		if (request.method === 'POST')
			init.body = await readRouteJson(
				request,
				BODY_LIMITS.configuration,
				'Send expected steps as JSON.',
			);
		return json(
			await projectApi(
				`/${projectId}/executions/${executionId}/metrics`,
				init,
				{
					403: 'Your role cannot change expected steps.',
					404: 'Run not found in this project.',
					409: 'Expected steps cannot be changed for an active or benchmark-linked run.',
					422: 'Check the selected tools and their expected arguments.',
				},
			),
		);
	} catch (error) {
		return routeError(error, 'Run evaluation could not be loaded.');
	}
}
export const GET = route;
export const POST = route;
