"""Small, versioned suite contract. Reference values never enter execution inputs."""

import json
import math
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Comparison(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["exact", "numeric_tolerance"] = "exact"
    absolute_tolerance: float = Field(default=0, ge=0, allow_inf_nan=False)
    relative_tolerance: float = Field(default=0, ge=0, allow_inf_nan=False)


class AnswerReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected: dict = Field(min_length=1, max_length=30)
    comparison: dict[str, Comparison]
    required_tools: (
        list[Literal["list_files", "read_file", "execute_python"]] | None
    ) = Field(default=None, min_length=1, max_length=3)

    @model_validator(mode="after")
    def valid_reference(self):
        if self.required_tools is not None and len(set(self.required_tools)) != len(
            self.required_tools
        ):
            raise ValueError("Required tools must be unique")
        if set(self.expected) != set(self.comparison):
            raise ValueError("Every expected field needs exactly one comparison rule")
        for key, value in self.expected.items():
            if not key or len(key) > 100:
                raise ValueError("Answer field names must contain 1 to 100 characters")
            rule = self.comparison[key]
            if rule.type == "numeric_tolerance" and (
                type(value) not in (int, float) or not math.isfinite(value)
            ):
                raise ValueError(
                    "Numeric tolerance requires a finite numeric reference"
                )
        try:
            if len(json.dumps(self.expected, allow_nan=False)) > 30000:
                raise ValueError("Reference answer too large")
        except (TypeError, OverflowError):
            raise ValueError("Reference must be JSON") from None
        return self


class Case(AnswerReference):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    question: str = Field(min_length=1, max_length=10000)

    @model_validator(mode="after")
    def nonempty_question(self):
        if not self.question.strip():
            raise ValueError("Question is required")
        return self


class Suite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=160)
    cases: list[Case] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def unique_cases(self):
        if len({case.id for case in self.cases}) != len(self.cases):
            raise ValueError("Case IDs must be unique")
        if len(json.dumps(self.model_dump(), allow_nan=False).encode()) > 200000:
            raise ValueError("Suite exceeds 200 KB")
        return self


class StartBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    revision: int = Field(ge=1, strict=True)
    dataset_id: UUID
    attempts: int = Field(default=1, ge=1, le=100, strict=True)
    suite: Suite
