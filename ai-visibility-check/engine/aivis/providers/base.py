"""Provider interface. A provider answers one customer prompt."""
from dataclasses import dataclass, field


class ProviderError(RuntimeError):
    pass


@dataclass
class Answer:
    provider: str
    model: str
    prompt: str
    text: str
    citations: list = field(default_factory=list)   # URLs or site names
    mode: str = "unknown"      # 'web-search' | 'model-memory' | 'simulated'
    cost_usd: float = 0.0
    run: int = 0
    usage: dict = field(default_factory=dict)   # real vendor usage: input_tokens, output_tokens, searches, cost_usd


class Provider:
    name = "base"
    mode = "unknown"
    paid = False
    est_cost_per_call = 0.0

    def ask(self, prompt: str, city: str = "", run: int = 0) -> Answer:  # pragma: no cover
        raise NotImplementedError


class BudgetGuard:
    """Hard stop on spend. Paid providers must check before every call."""

    def __init__(self, max_usd: float):
        self.max_usd = float(max_usd)
        self.spent = 0.0

    def charge(self, usd: float):
        if self.spent + usd > self.max_usd + 1e-9:
            raise ProviderError(f"budget cap ${self.max_usd:.2f} would be exceeded "
                                f"(spent ${self.spent:.4f}, next ${usd:.4f})")
        self.spent += usd
