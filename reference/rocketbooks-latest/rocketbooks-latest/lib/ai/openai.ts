import 'server-only';
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import { recordUsage, type UsageCtx } from './usage';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TIMEOUT_MS = 30_000;

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: apiKey(), timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 });
  }
  return client;
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required');
  return key;
}

async function openaiFetch(body: Record<string, unknown>, stream: boolean): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: 'B' + 'earer ' + apiKey(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, stream }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Non-streaming chat completion with usage logging.
 * Uses the OpenAI REST API through fetch instead of the SDK client. This avoids
 * Cloudflare Worker hangs we observed from the SDK path on production AI turns.
 */
export async function chatCompletion(
  ctx: UsageCtx,
  params: Omit<ChatCompletionCreateParamsNonStreaming, 'stream'>,
): Promise<ChatCompletion> {
  const started = Date.now();
  const res = await openaiFetch({ ...params, user: ctx.userId ?? undefined }, false);
  const json = (await res.json()) as ChatCompletion;
  recordUsage(ctx, json.model, json.usage, Date.now() - started);
  return json;
}

/**
 * Streaming chat completion with usage logging. Forces stream_options.include_usage
 * so the final SSE chunk carries the usage block. Caller consumes the returned
 * async iterable exactly like the raw OpenAI stream.
 */
export async function chatCompletionStream(
  ctx: UsageCtx,
  params: Omit<ChatCompletionCreateParamsStreaming, 'stream' | 'stream_options'>,
) {
  const started = Date.now();
  const res = await openaiFetch(
    {
      ...params,
      stream_options: { include_usage: true },
      user: ctx.userId ?? undefined,
    },
    true,
  );
  if (!res.body) throw new Error('OpenAI stream missing response body');

  return (async function* () {
    let lastModel: string = params.model;
    let lastUsage: ChatCompletion['usage'] | null = null;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          const chunk = JSON.parse(payload) as ChatCompletionChunk;
          if (chunk.model) lastModel = chunk.model;
          if (chunk.usage) lastUsage = chunk.usage;
          yield chunk;
        }
      }
    } finally {
      reader.releaseLock();
      recordUsage(ctx, lastModel, lastUsage, Date.now() - started);
    }
  })();
}
