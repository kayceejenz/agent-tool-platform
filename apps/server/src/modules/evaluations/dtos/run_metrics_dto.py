import json

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ExpectedStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool_key: str = Field(min_length=1, max_length=200)
    arguments: dict


class SaveExpectedSteps(BaseModel):
    model_config = ConfigDict(extra="forbid")
    steps: list[ExpectedStep] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def bounded(self):
        if len(json.dumps(self.model_dump(), allow_nan=False).encode()) > 200_000:
            raise ValueError("Expected steps exceed 200 KB")
        return self
