from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from modules.evaluations.dtos.evaluation_dto import Expectations
from modules.analysis_evaluations.dtos.suite_dto import AnswerReference


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset_id: UUID


class StartExecution(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1, strict=True)
    request_id: UUID
    analysis: AnalysisRequest | None = None
    answer_reference: AnswerReference | None = None
    benchmark_id: UUID | None = None
    expectations: Expectations | None = None
    llm_evaluation: bool = Field(default=True, strict=True)
    input: str = Field(min_length=1, max_length=16000)

    @field_validator("input")
    @classmethod
    def clean_input(cls, value):
        if not value.strip() or "\x00" in value:
            raise ValueError("Task required")
        return value.strip()

    @model_validator(mode="after")
    def analysis_is_not_benchmark(self):
        if self.answer_reference is not None and (
            not self.analysis or self.benchmark_id or len(self.input) > 10000
        ):
            raise ValueError(
                "Answer evaluation requires a dataset and a question of at most 10000 characters"
            )
        if self.analysis and self.benchmark_id:
            raise ValueError("Analysis runs cannot use tool benchmarks")
        return self
