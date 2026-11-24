import { json } from '@/lib/auth/server';
import { projectApi } from '@/lib/projects/server';
import { routeError, uuidPattern } from '@/lib/http/project-route';
export async function GET(_request: Request, context: { params: Promise<{ projectId: string; executionId: string }> }) {
	const { projectId, executionId } = await context.params;
	if (!uuidPattern.test(projectId) || !uuidPattern.test(executionId)) return json({ error: 'Execution not found.' }, 404);
	try { return json(await projectApi(`/${projectId}/executions/${executionId}/answer-evaluation`)); }
	catch (error) { return routeError(error, 'Answer evaluation could not be loaded.'); }
}
