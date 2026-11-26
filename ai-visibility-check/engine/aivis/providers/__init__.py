from .base import Answer, Provider, ProviderError, BudgetGuard
from .mock import MockProvider, Business
from .free import PollinationsProvider
from .paid import OpenAIWebSearchProvider, GeminiGroundedProvider, ClaudeWebSearchProvider, PAID_COST_PER_CALL

REGISTRY = {
    "mock": MockProvider,
    "pollinations": PollinationsProvider,
    "openai": OpenAIWebSearchProvider,
    "gemini": GeminiGroundedProvider,
    "claude": ClaudeWebSearchProvider,
}
