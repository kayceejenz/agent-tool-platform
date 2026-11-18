import { ProjectUsage } from './project-usage';
import type { Project } from '@/types/workspace';

export function ProjectDashboard({ project }: { project: Project }) {
	return <ProjectUsage projectId={project.id} />;
}
