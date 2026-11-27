from .base import Answer, Provider, ProviderError, BudgetGuard
from .mock import MockProvider, Business
from .free import PollinationsProvider
from .paid import OpenAIWebSearchProvider, GeminiGroundedProvider, ClaudeWebSearchProvider, PAID_COST_PER_CALL

__all__ = ["Answer", "Provider", "ProviderError", "BudgetGuard", "MockProvider", "Business", "PollinationsProvider",
           "OpenAIWebSearchProvider", "GeminiGroundedProvider", "ClaudeWebSearchProvider", "PAID_COST_PER_CALL", "REGISTRY"]

REGISTRY = {
    "mock": MockProvider,
    "pollinations": PollinationsProvider,
    "openai": OpenAIWebSearchProvider,
    "gemini": GeminiGroundedProvider,
    "claude": ClaudeWebSearchProvider,
}
