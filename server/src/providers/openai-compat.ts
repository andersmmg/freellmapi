import type {
  ChatMessage,
  ContentPart,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
  TranscriptionResult,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
import { setDynamicLimit } from '../services/ratelimit.js';

/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
function parseRateLimitHeaders(headers: Headers, platform: string, modelId: string, keyId?: number) {
  if (!keyId) return;

  // Most OpenAI-compatible providers return these (Groq, OpenRouter, etc.)
  const tpmLimit = headers.get('x-ratelimit-limit-tokens');
  const rpmLimit = headers.get('x-ratelimit-limit-requests');
  const remainingTokens = headers.get('x-ratelimit-remaining-tokens');
  const remainingRequests = headers.get('x-ratelimit-remaining-requests');

  if (tpmLimit) {
    const limit = parseInt(tpmLimit, 10);
    if (limit > 0) setDynamicLimit(`${platform}:${modelId}:${keyId}:tpm`, limit);
  }
  if (rpmLimit) {
    const limit = parseInt(rpmLimit, 10);
    if (limit > 0) setDynamicLimit(`${platform}:${modelId}:${keyId}:rpm`, limit);
  }
  // If remaining is 0, we're at the limit — set a short cooldown to give
  // the router a chance to pick a different model rather than retry this one.
  if (remainingTokens === '0') {
    setDynamicLimit(`${platform}:${modelId}:${keyId}:tpm`, 1);
  }
  if (remainingRequests === '0') {
    setDynamicLimit(`${platform}:${modelId}:${keyId}:rpm`, 0);
  }
}

export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  private readonly timeoutMs: number;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
    validateUrl?: string;
    timeoutMs?: number;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      }),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    // Learn rate limits from response headers (Groq, OpenRouter, etc.)
    parseRateLimitHeaders(res.headers, this.platform, modelId, options?.keyId);

    const data = await res.json() as ChatCompletionResponse;
    normalizeChoices(data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
      }),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    // Learn rate limits from response headers (Groq, OpenRouter, etc.)
    parseRateLimitHeaders(res.headers, this.platform, modelId, options?.keyId);

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async transcribe(
    apiKey: string,
    audioData: Buffer,
    fileName: string,
    modelId: string,
    options?: { language?: string; prompt?: string; response_format?: string; temperature?: number },
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    const type = fileName.endsWith('.mp3') ? 'audio/mpeg'
      : fileName.endsWith('.wav') ? 'audio/wav'
      : fileName.endsWith('.ogg') ? 'audio/ogg'
      : fileName.endsWith('.m4a') ? 'audio/mp4'
      : 'audio/webm';
    form.append('file', new File([audioData], fileName, { type }));
    form.append('model', modelId);
    if (options?.language) form.append('language', options.language);
    if (options?.prompt) form.append('prompt', options.prompt);
    if (options?.response_format) form.append('response_format', options.response_format);
    if (options?.temperature != null) form.append('temperature', String(options.temperature));

    const res = await this.fetchWithTimeout(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, ...this.extraHeaders },
      body: form,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    return res.json() as Promise<TranscriptionResult>;
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Note: transport errors (DNS / timeout / TLS) propagate to the caller.
    // health.ts catches them and marks status='error' WITHOUT incrementing
    // the consecutive-failure counter — only confirmed 401/403 disables a key.
    const url = this.validateUrl ?? `${this.baseUrl}/models`;
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...this.extraHeaders,
      },
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }
}

/**
 * Some providers (Z.ai glm-4.5-flash, Cloudflare DeepSeek-R1-distill, others)
 * return reasoning models' actual answer in `message.reasoning_content` with
 * `message.content === ""`. Fold reasoning_content into content so OpenAI-
 * compatible clients see a non-empty assistant message.
 *
 * Other providers (Mistral magistral-medium) return `message.content` as an
 * array of text segments instead of a string. Flatten to string.
 */
function normalizeChoices(data: ChatCompletionResponse): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message as ChatMessage & {
      reasoning_content?: string;
      reasoning?: string;
      content: unknown;
    };
    // Flatten array content (Mistral magistral) → join text segments.
    // Only flatten text-only arrays; preserve multimodal content arrays.
    if (Array.isArray(msg.content)) {
      const parts = msg.content as ContentPart[];
      if (parts.every(p => p.type === 'text')) {
        msg.content = parts.map(p => p.text).join('');
      }
    }
    // Fold reasoning into content if content is empty AND there are no
    // tool_calls. With tool_calls present, content=null is the correct OpenAI
    // shape; folding reasoning would confuse clients that branch on content.
    // Field naming varies by provider: Z.ai uses `reasoning_content`, Ollama
    // uses `reasoning`. Prefer `reasoning_content` when both are set.
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
      const fold = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
        ? msg.reasoning_content
        : (typeof msg.reasoning === 'string' && msg.reasoning.length > 0 ? msg.reasoning : null);
      if (fold !== null) msg.content = fold;
    }
  }
}
