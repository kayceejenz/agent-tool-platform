from uuid import UUID

from api.dependencies import User
from fastapi import APIRouter, Query, Request

from modules.analysis_evaluations.dtos.suite_dto import StartBatch

router = APIRouter(
    prefix="/projects/{project_id}/agents/{agent_id}/analysis-evaluations",
    tags=["analysis evaluations"],
)


@router.post("", status_code=202)
async def start(
    project_id: UUID, agent_id: UUID, body: StartBatch, user: User, request: Request
):
    return await request.app.state.analysis_evaluations.create(
        user.id, project_id, agent_id, body
    )


@router.get("")
async def history(
    project_id: UUID,
    agent_id: UUID,
    user: User,
    request: Request,
    offset: int = Query(default=0, ge=0, le=100000),
):
    return await request.app.state.analysis_evaluations.list(
        user.id, project_id, agent_id, offset
    )


@router.get("/{batch_id}")
async def details(
    project_id: UUID, agent_id: UUID, batch_id: UUID, user: User, request: Request
):
    return await request.app.state.analysis_evaluations.get(
        user.id, project_id, agent_id, batch_id
    )


@router.post("/{batch_id}/cancel")
async def cancel(
    project_id: UUID, agent_id: UUID, batch_id: UUID, user: User, request: Request
):
    return await request.app.state.analysis_evaluations.cancel(
        user.id, project_id, agent_id, batch_id
    )
