"""Integration probe for selected SDK semantics; not a product runtime entry point."""

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    import annotated_types  # noqa: F401 — Pydantic loads this lazily during replay.
    from pydantic_ai import Agent
    from pydantic_ai.durable_exec.temporal import PydanticAIWorkflow, TemporalDurability
    from pydantic_ai.models.test import TestModel
    from pydantic_ai.usage import UsageLimits

    from dive_trip.modules.planning.answer_contract import AnswerPlan, Receipt


durability = TemporalDurability(
    activity_config={
        "start_to_close_timeout": timedelta(seconds=10),
        "retry_policy": RetryPolicy(maximum_attempts=1),
    },
    model_activity_config={
        "start_to_close_timeout": timedelta(seconds=10),
        "retry_policy": RetryPolicy(maximum_attempts=1),
    },
)
agent = Agent(
    TestModel(
        call_tools=[],
        custom_output_args={
            "version": "1",
            "answer": {"kind": "clarify", "fields": ["budget"]},
        },
    ),
    output_type=AnswerPlan,
    name="dive_contract_probe",
    retries=0,
    capabilities=[durability],
)


@workflow.defn
class ContractProbe(PydanticAIWorkflow):
    __pydantic_ai_agents__ = [agent]

    def __init__(self):
        self.decision = None
        self.ready = False

    @workflow.run
    async def run(self) -> dict:
        result = await agent.run(
            "synthetic contract probe", usage_limits=UsageLimits(request_limit=7)
        )
        self.ready = True
        await workflow.wait_condition(
            lambda: self.decision is not None, timeout=timedelta(seconds=30)
        )
        receipt = Receipt(
            status="applied" if self.decision else "rejected",
            version=2 if self.decision else 1,
        )
        return {
            "plan": result.output.model_dump(mode="json"),
            "receipt": receipt.model_dump(mode="json"),
        }

    @workflow.signal
    def decide(self, accepted: bool) -> None:
        if self.decision is None:
            self.decision = accepted

    @workflow.query
    def awaiting_confirmation(self) -> bool:
        return self.ready
