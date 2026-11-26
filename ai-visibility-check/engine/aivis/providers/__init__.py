from .base import Answer, Provider, ProviderError, BudgetGuard
from .mock import MockProvider, Business
from .free import PollinationsProvider
from .gemini_free import GeminiFreeProvider
from .paid import OpenAIWebSearchProvider, GeminiGroundedProvider, ClaudeWebSearchProvider, PAID_COST_PER_CALL

REGISTRY = {
    "mock": MockProvider,
    "pollinations": PollinationsProvider,
    "gemini-free": GeminiFreeProvider,
    "openai": OpenAIWebSearchProvider,
    "gemini": GeminiGroundedProvider,
    "claude": ClaudeWebSearchProvider,
}
