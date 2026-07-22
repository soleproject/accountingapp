"""Drop-in LLM client that mimics the `emergentintegrations` API surface
(`LlmChat`, `UserMessage`, `TextDelta`, `StreamDone`) but routes to the
provider selected by env var so the same code runs on Emergent OR any
other host (Railway, Fly, self-hosted, etc.).

Selection is done via `LLM_PROVIDER` — one of:
    openai      — default. Requires OPENAI_API_KEY. Model set via
                  `LLM_MODEL` (e.g. gpt-4o-mini, gpt-4o).
    anthropic   — Requires ANTHROPIC_API_KEY. Model set via `LLM_MODEL`
                  (e.g. claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001).

The call-site API is intentionally identical to emergentintegrations so
the rest of the codebase doesn't change:

    from llm_client import LlmChat, UserMessage, TextDelta, StreamDone
    chat = LlmChat(api_key=..., session_id=..., system_message=...)\
             .with_model("openai", "gpt-4o-mini")
    async for ev in chat.stream_message(UserMessage(text="hi")):
        if isinstance(ev, TextDelta): ...
        elif isinstance(ev, StreamDone): break

Notes:
- `send_message` is a non-streaming convenience that returns the full
  reply as a plain str.
- `session_id` is accepted for API compat but not used — every call is a
  fresh, stateless request (matches how the rest of the app used it).
- If `with_model` is called it wins over the env default. This lets
  callers pick a cheaper model (Haiku/mini) for lightweight tasks
  without a global env change.
"""
from __future__ import annotations
import os
from typing import AsyncGenerator, Union


# ---------------------------------------------------------------------------
# Message + event shapes (mirror emergentintegrations)
# ---------------------------------------------------------------------------
class UserMessage:
    __slots__ = ("text",)

    def __init__(self, text: str):
        self.text = text


class TextDelta:
    __slots__ = ("content",)

    def __init__(self, content: str):
        self.content = content


class StreamDone:
    __slots__ = ()


# ---------------------------------------------------------------------------
# Provider defaults from env
# ---------------------------------------------------------------------------
DEFAULT_PROVIDER = os.environ.get("LLM_PROVIDER", "openai").lower()
DEFAULT_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")

# Lazy per-provider clients so we only import + instantiate what's needed.
_openai_client = None
_anthropic_client = None


def _openai():
    global _openai_client
    if _openai_client is None:
        from openai import AsyncOpenAI
        _openai_client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    return _openai_client


def _anthropic():
    global _anthropic_client
    if _anthropic_client is None:
        from anthropic import AsyncAnthropic
        _anthropic_client = AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _anthropic_client


# ---------------------------------------------------------------------------
# Chat object
# ---------------------------------------------------------------------------
class LlmChat:
    def __init__(self, api_key: str = "", session_id: str = "", system_message: str = ""):
        # api_key is accepted for signature-compat with the old
        # emergentintegrations call — we use env-based keys instead so
        # the same code works on any host.
        self.system = system_message or ""
        self.session_id = session_id
        self.provider = DEFAULT_PROVIDER
        self.model = DEFAULT_MODEL

    def with_model(self, provider: str, model: str) -> "LlmChat":
        # Legacy calls pass ("anthropic", "claude-sonnet-4-5-…"). We honor
        # the explicit provider unless the deploy is locked to a single
        # vendor via env — in that case env wins so a Railway deploy with
        # only OPENAI_API_KEY never blows up on an Anthropic call.
        if provider:
            self.provider = provider.lower()
        if model:
            self.model = model
        return self

    # ------------------------------------------------------------------
    # Streaming — yields TextDelta(content=…) chunks then a StreamDone()
    # ------------------------------------------------------------------
    async def stream_message(
        self, msg: UserMessage
    ) -> AsyncGenerator[Union[TextDelta, StreamDone], None]:
        provider = self._resolve_provider()
        if provider == "anthropic":
            async for ev in self._stream_anthropic(msg.text):
                yield ev
        else:
            async for ev in self._stream_openai(msg.text):
                yield ev

    async def _stream_openai(self, text: str):
        client = _openai()
        stream = await client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": self.system},
                {"role": "user", "content": text},
            ],
            stream=True,
        )
        async for chunk in stream:
            try:
                delta = chunk.choices[0].delta.content
            except (IndexError, AttributeError):
                delta = None
            if delta:
                yield TextDelta(content=delta)
        yield StreamDone()

    async def _stream_anthropic(self, text: str):
        client = _anthropic()
        async with client.messages.stream(
            model=self.model,
            system=self.system,
            messages=[{"role": "user", "content": text}],
            max_tokens=4096,
        ) as stream:
            async for delta in stream.text_stream:
                if delta:
                    yield TextDelta(content=delta)
        yield StreamDone()

    # ------------------------------------------------------------------
    # Non-streaming — returns the full assistant reply as a str
    # ------------------------------------------------------------------
    async def send_message(self, msg: UserMessage) -> str:
        provider = self._resolve_provider()
        if provider == "anthropic":
            client = _anthropic()
            resp = await client.messages.create(
                model=self.model,
                system=self.system,
                messages=[{"role": "user", "content": msg.text}],
                max_tokens=4096,
            )
            # Anthropic returns a list of content blocks; join text parts.
            parts = []
            for block in getattr(resp, "content", []) or []:
                t = getattr(block, "text", None)
                if t:
                    parts.append(t)
            return "".join(parts)
        # OpenAI
        client = _openai()
        resp = await client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": self.system},
                {"role": "user", "content": msg.text},
            ],
        )
        try:
            return resp.choices[0].message.content or ""
        except (IndexError, AttributeError):
            return ""

    # ------------------------------------------------------------------
    def _resolve_provider(self) -> str:
        """Pick the provider actually usable in this deploy.

        If the caller asked for anthropic but the env only has an OpenAI
        key (or vice-versa), fall back so the app keeps working. This
        lets us leave `with_model("anthropic", ...)` calls in the code
        without breaking a Railway deploy that only has OPENAI_API_KEY.
        """
        req = self.provider
        has_openai = bool(os.environ.get("OPENAI_API_KEY"))
        has_anthropic = bool(os.environ.get("ANTHROPIC_API_KEY"))
        if req == "anthropic" and not has_anthropic and has_openai:
            # Silent fallback — map Claude model → env default OpenAI model.
            self.model = os.environ.get("LLM_MODEL", "gpt-4o-mini")
            return "openai"
        if req == "openai" and not has_openai and has_anthropic:
            self.model = os.environ.get("LLM_MODEL", "claude-sonnet-4-5-20250929")
            return "anthropic"
        return req
