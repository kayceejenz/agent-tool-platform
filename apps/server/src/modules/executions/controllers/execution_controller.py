import asyncio
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from api.dependencies import Agents, Config, Executions, RunMetrics, User
from fastapi import APIRouter, Query, Response, Request
from integrations.agents.model_provider import SUPPORTED_PROVIDERS, provider_key
from integrations.sandbox.artifacts import ArtifactStorage

from modules.agents.models.error_model import AgentError
from modules.analysis_evaluations.dtos.suite_dto import StartBatch, Suite, Case
from modules.evaluations.dtos.run_metrics_dto import SaveExpectedSteps
from modules.executions.dtos.execution_dto import StartExecution

router = APIRouter(prefix="/projects/{project_id}", tags=["executions"])


@router.post("/agents/{agent_id}/executions", status_code=202)
async def start(
    project_id: UUID,
    agent_id: UUID,
    body: StartExecution,
    request: Request,
    user: User,
    executions: Executions,
    agents: Agents,
    config: Config,
):
    agent = await agents.get(user.id, project_id, agent_id, body.revision)
    provider = agent["model_settings"]["provider"].lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise AgentError(
            422, "The runtime supports OpenAI, Google, Anthropic and Ollama"
        )
    if provider_key(config, provider) is None:
        variable = {
            "google": "AGENT_GOOGLE_API_KEY",
            "openai": "AGENT_OPENAI_API_KEY",
            "anthropic": "AGENT_ANTHROPIC_API_KEY",
        }[provider]
        raise AgentError(503, f"Set {variable} on the server to run this agent")
    if body.answer_reference is not None:
        batches = request.app.state.analysis_evaluations
        batch = await batches.create(
            user.id,
            project_id,
            agent_id,
            StartBatch(
                request_id=body.request_id,
                revision=body.revision,
                dataset_id=body.analysis.dataset_id,
                attempts=1,
                suite=Suite(
                    name="Playground answer evaluation",
                    cases=[
                        Case(
                            id="RUN",
                            question=body.input,
                            **body.answer_reference.model_dump(),
                        )
                    ],
                ),
            ),
        )
        detail = await batches.get(user.id, project_id, agent_id, batch["id"])
        attempt = detail["attempts"][0]
        return {"id": attempt["execution_id"], "status": attempt["execution_status"]}
    result = await executions.start(user.id, project_id, agent_id, body)
    return {"id": result["id"], "status": result["status"]}


@router.get("/agents/{agent_id}/executions")
async def history(
    project_id: UUID,
    agent_id: UUID,
    user: User,
    executions: Executions,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
):
    return await executions.list(user.id, project_id, agent_id, offset)


@router.get("/executions/{execution_id}")
async def detail(
    project_id: UUID,
    execution_id: UUID,
    user: User,
    executions: Executions,
    view: Literal["full", "summary", "status"] = "full",
):
    return await executions.get(user.id, project_id, execution_id, view)


@router.post("/executions/{execution_id}/cancel")
async def cancel(
    project_id: UUID,
    execution_id: UUID,
    user: User,
    executions: Executions,
    view: Literal["full", "summary"] = "full",
):
    return await executions.cancel(user.id, project_id, execution_id, view)


@router.get("/executions/{execution_id}/spans")
async def spans(
    project_id: UUID,
    execution_id: UUID,
    user: User,
    executions: Executions,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
):
    return await executions.trace(user.id, project_id, execution_id, offset)


@router.get("/executions/{execution_id}/spans/{span_id}")
async def span(
    project_id: UUID,
    execution_id: UUID,
    span_id: UUID,
    user: User,
    executions: Executions,
):
    return await executions.trace(user.id, project_id, execution_id, span_id=span_id)


@router.get("/executions/{execution_id}/snapshot")
async def snapshot(
    project_id: UUID, execution_id: UUID, user: User, executions: Executions
):
    return await executions.trace(user.id, project_id, execution_id, snapshot=True)


@router.get("/executions/{execution_id}/artifacts")
async def artifacts(
    project_id: UUID,
    execution_id: UUID,
    user: User,
    executions: Executions,
    config: Config,
):
    record = await executions.analysis_details(user.id, project_id, execution_id)
    return await asyncio.to_thread(ArtifactStorage(config).listing, record)


@router.get("/executions/{execution_id}/artifacts/{artifact_id}/preview")
async def artifact_preview(
    project_id: UUID,
    execution_id: UUID,
    artifact_id: str,
    user: User,
    executions: Executions,
    config: Config,
):
    record = await executions.analysis_details(user.id, project_id, execution_id)
    return await asyncio.to_thread(ArtifactStorage(config).preview, record, artifact_id)


@router.get("/executions/{execution_id}/artifacts/{artifact_id}")
async def artifact_download(
    project_id: UUID,
    execution_id: UUID,
    artifact_id: str,
    user: User,
    executions: Executions,
    config: Config,
    inline: bool = False,
):
    record = await executions.analysis_details(user.id, project_id, execution_id)
    item, data, media_type = await asyncio.to_thread(
        ArtifactStorage(config).read, record, artifact_id
    )
    name = Path(item["name"]).name
    disposition = "inline" if inline and media_type == "image/png" else "attachment"
    return Response(
        data,
        media_type=media_type,
        headers={
            "Content-Disposition": f"{disposition}; filename=analysis-output{Path(artifact_id).suffix}; filename*=UTF-8''{quote(name, safe='')}",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@router.get("/executions/{execution_id}/metrics")
async def metrics(
    project_id: UUID, execution_id: UUID, user: User, metrics: RunMetrics
):
    return await metrics.get(user.id, project_id, execution_id)


@router.post("/executions/{execution_id}/metrics")
async def save_metrics(
    project_id: UUID,
    execution_id: UUID,
    body: SaveExpectedSteps,
    user: User,
    metrics: RunMetrics,
):
    return await metrics.save(user.id, project_id, execution_id, body)


@router.get("/executions/{execution_id}/answer-evaluation")
async def answer_evaluation(
    project_id: UUID, execution_id: UUID, user: User, request: Request
):
    return await request.app.state.analysis_evaluations.for_execution(
        user.id, project_id, execution_id
    )
