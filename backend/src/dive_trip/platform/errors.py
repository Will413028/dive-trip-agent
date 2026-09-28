class DomainError(Exception):
    """A public, allowlisted product error code; never a database message."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class ToolArgumentsRejected(DomainError):
    """Raised only after rejecting a declared tool's strict argument schema."""

    def __init__(self) -> None:
        super().__init__("AGENT_TOOL_ARGUMENTS_REJECTED")


class ModelDispatchNotStarted(DomainError):
    """Only preflight rejection before a call-start transaction can commit."""

    def __init__(self) -> None:
        super().__init__("MODEL_DISPATCH_NOT_STARTED")
