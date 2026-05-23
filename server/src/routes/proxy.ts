import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AutoMode, ChatMessage } from '@freellmapi/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../services/ratelimit.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { BaseProvider } from '../providers/base.js';
import { contentToString } from '../lib/content.js';
import busboy from 'busboy';

export const proxyRouter = Router();

// Virtual "auto" model. Clients like Hermes require a non-empty `model` field
// on every request, but freellmapi's whole point is to pick the model itself.
// Requesting this id means "let the router decide" — identical to omitting
// `model` entirely.
const AUTO_MODEL_ID = 'auto';

// Constant-time string comparison for the unified API key. Plain `===` leaks
// length and per-character timing, which a network attacker could in principle
// use to recover the key one byte at a time.
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare against a same-length buffer regardless of input length so the
  // comparison itself runs in constant time; the explicit length check at the
  // end is what actually decides equality when lengths differ.
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(messages: ChatMessage[]): string {
  // Use the first user message as session identifier — clients like Hermes
  // re-send the full conversation each turn, so the first user message is
  // stable across turns. Hash the FULL message (not a 100-char slice) so
  // distinct conversations with identical openings don't collide.
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const content = typeof firstUser.content === 'string'
    ? firstUser.content
    : Array.isArray(firstUser.content)
      ? firstUser.content.map(p => p.type === 'text' ? p.text : '[image]').join('')
      : '';
  if (!content) return '';
  const hash = crypto.createHash('sha1').update(content).digest('hex');
  return `${hash}:${messages.length > 2 ? 'multi' : 'single'}`;
}

function getStickyModel(messages: ChatMessage[], autoMode?: AutoMode): number | undefined {
  // Only apply sticky for multi-turn (has assistant messages = continuation)
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = `${getSessionKey(messages)}:${autoMode ?? 'default'}`;
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

function setStickyModel(messages: ChatMessage[], modelDbId: number, autoMode?: AutoMode) {
  const key = `${getSessionKey(messages)}:${autoMode ?? 'default'}`;
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

// OpenAI-compatible /models endpoint (used by Hermes for metadata)
proxyRouter.get('/models', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare('SELECT platform, model_id, display_name, context_window FROM models WHERE enabled = 1 ORDER BY intelligence_rank').all() as any[];
  const autoModes = [
    { id: 'auto', name: 'Auto (balanced)', owned_by: 'freellmapi', context_window: null },
    { id: 'auto/smart', name: 'Auto (smart)', owned_by: 'freellmapi', context_window: null },
    { id: 'auto/fast', name: 'Auto (fast)', owned_by: 'freellmapi', context_window: null },
  ];
  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Auto (router picks the best available model)',
        context_window: null,
      },
      ...models.map(m => ({
        id: m.model_id,
        object: 'model',
        created: 0,
        owned_by: m.platform,
        name: m.display_name,
        context_window: m.context_window,
      })),
      ...autoModes.map(m => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.owned_by,
        name: m.name,
        context_window: m.context_window,
      })),
    ],
  });
});

const MAX_RETRIES = 20;

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
  thought_signature: z.string().optional(),
});

// OpenAI multimodal envelope. Clients like opencode / continue.dev send
// content as an array of typed blocks even when only text is present. We
// accept the envelope on the wire and flatten to string for providers that
// don't support arrays (Cohere, Cloudflare). Non-text blocks pass z validation
// but get dropped by contentToString — vision/audio still isn't supported.
const contentBlockSchema = z.object({ type: z.string() }).passthrough();
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);

function hasNonEmptyContent(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: contentSchema,
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: contentSchema,
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([contentSchema, z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
}).refine((msg) => {
  const hasContent = hasNonEmptyContent(msg.content);
  const hasToolCalls = (msg.tool_calls?.length ?? 0) > 0;
  return hasContent || hasToolCalls;
}, {
  message: 'assistant messages must include non-empty content or tool_calls',
});

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: contentSchema,
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

export function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    // 413: this model's payload limit is too small for the request, but another
    // provider in the fallback chain may have a larger limit. Same reasoning as 503.
    || msg.includes('413') || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
    // 404: model deprecated/removed upstream (e.g. OpenRouter's "no endpoints found"
    // for a model that's been pulled). Rotate to the next model in the chain —
    // setCooldown + the health checker will avoid this model on subsequent requests.
    || msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    || msg.includes('no longer available')
    || msg.includes('thought_signature');
}

function isPermanentError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('no longer available') || msg.includes('has transitioned');
}

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();

  // Authenticate with the unified API key for every proxy request, including
  // loopback callers. Browser pages can reach localhost, so socket locality is
  // not a reliable authorization boundary.
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { model: requestedModel, temperature, max_tokens, top_p, stream, tools, tool_choice, parallel_tool_calls } = parsed.data;
  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
          thought_signature: tc.thought_signature,
        })) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        ...(m.name ? { name: m.name } : {}),
      };
    }

    return {
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  function estimateTokens(content: ChatMessage['content']): number {
    if (typeof content === 'string') return Math.ceil(content.length / 4);
    if (Array.isArray(content)) {
      return content.reduce((sum, part) => {
        if (part.type === 'text') return sum + Math.ceil((part.text ?? '').length / 4);
        return sum + 100;
      }, 0);
    }
    return 0;
  }

  const estimatedInputTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

  // Parse auto-routing modes: auto, auto/fast, auto/smart, etc.
  // auto/{mode} strips the prefix and uses the mode for sort prioritization.
  let preferredModel: number | undefined;
  let autoMode: AutoMode | undefined;
  if (requestedModel) {
    const autoMatch = requestedModel.match(/^auto(?:\/(\w+))?$/);
    if (autoMatch) {
      autoMode = autoMatch[1] as AutoMode | undefined;
      if (autoMode && !['smart', 'fast'].includes(autoMode)) {
        res.status(400).json({
          error: {
            message: `Unknown auto mode '${autoMode}'. Supported: auto, auto/smart, auto/fast.`,
            type: 'invalid_request_error',
          },
        });
        return;
      }
      preferredModel = getStickyModel(messages, autoMode);
    } else {
      // Explicit model pinning
      const db = getDb();
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        res.status(400).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
    }
  } else {
    preferredModel = getStickyModel(messages);
  }

  // Check if any message contains image content parts
  const requiresMultimodal = messages.some(m =>
    Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'),
  );

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, requiresMultimodal || undefined, autoMode);
    } catch (err: any) {
      // No more models available
      if (lastError) {
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${lastError.message}`,
            type: 'rate_limit_error',
          },
        });
      } else {
        res.status(err.status ?? 503).json({
          error: { message: err.message, type: 'routing_error' },
        });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let totalOutputTokens = 0;
        let streamStarted = false;
        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
          );

          for await (const chunk of gen) {
            if (!streamStarted) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
              if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
              streamStarted = true;
            }
            const text = chunk.choices[0]?.delta?.content ?? '';
            totalOutputTokens += Math.ceil(text.length / 4);
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          if (!streamStarted) {
            // Upstream returned no chunks — emit minimal successful stream.
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          }
          res.write('data: [DONE]\n\n');
          res.end();

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId, autoMode);
          return;
        } catch (streamErr: any) {
          if (streamStarted) {
            // Mid-stream error — finish the SSE response cleanly instead of leaving
            // the client hanging or letting Express's default handler take over.
            // Full upstream message goes to the log; the client sees a generic
            // message so we don't leak provider internals into a partial stream.
            console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, streamErr.message);
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
        );

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId, autoMode);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(result);

        logRequest(
          route.platform, route.modelId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, null,
        );
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, err.message);

      if (isRetryableError(err)) {
        // Put this model+key on cooldown and try the next one
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        if (isPermanentError(err)) {
          const db = getDb();
          db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(route.modelDbId);
          console.log(`[Proxy] Disabling ${route.displayName} — ${err.message.slice(0, 120)}`);
        } else {
          setCooldown(route.platform, route.modelId, route.keyId, 120_000);
        }
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 80)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Non-retryable error (auth, 4xx, etc.): don't retry
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  // Exhausted all retries
  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
});

// ── Audio Transcription ──

function parseMultipart(req: Request): Promise<{ fields: Record<string, string>; file: Buffer; fileName: string }> {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    const fields: Record<string, string> = {};
    let file: Buffer | null = null;
    let fileName = '';

    bb.on('field', (name: string, val: string) => { fields[name] = val; });
    bb.on('file', (_fieldname: string, stream: any, info: { filename: string }) => {
      fileName = info.filename;
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => { file = Buffer.concat(chunks); });
    });
    bb.on('finish', () => {
      if (!file) return reject(new Error('No file uploaded'));
      resolve({ fields, file, fileName });
    });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

proxyRouter.post('/audio/transcriptions', async (req: Request, res: Response) => {
  const start = Date.now();

  // Auth (same as chat completions)
  const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (!isLocal) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.status(401).json({ error: { message: 'Missing or invalid API key', type: 'auth_error', code: 'missing_api_key' } });
      return;
    }
    const expected = getUnifiedApiKey();
    if (!timingSafeStringEqual(auth.slice(7), expected)) {
      res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error', code: 'invalid_api_key' } });
      return;
    }
  }

  let fields: Record<string, string>;
  let file: Buffer;
  let fileName: string;
  try {
    const parsed = await parseMultipart(req);
    fields = parsed.fields;
    file = parsed.file;
    fileName = parsed.fileName || 'audio.webm';
  } catch (err: any) {
    res.status(400).json({ error: { message: err.message || 'Invalid multipart upload', type: 'invalid_request_error' } });
    return;
  }

  const modelId = fields.model || 'whisper-large-v3';
  const db = getDb();

  // Determine which providers to try
  interface TranscriptionTry { provider: BaseProvider; apiKey: string; keyId: number; modelId: string; displayName: string; platform: string }
  const candidates: TranscriptionTry[] = [];

  if (fields.model) {
    // Specific model — look up the exact model
    const row = db.prepare('SELECT id, platform, model_id, display_name FROM models WHERE model_id = ? AND enabled = 1').get(modelId) as any | undefined;
    if (row) {
      const provider = getProvider(row.platform);
      if (provider?.transcribe) {
        const keyRow = db.prepare('SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ? ORDER BY id LIMIT 1').get(row.platform, 'invalid') as any | undefined;
        if (keyRow) {
          const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
          candidates.push({ provider, apiKey, keyId: keyRow.id, modelId: row.model_id, displayName: row.display_name, platform: row.platform });
        }
      }
    }
    if (candidates.length === 0) {
      res.status(400).json({ error: { message: `Model '${modelId}' not found or no keys available for transcription`, type: 'invalid_request_error' } });
      return;
    }
  } else {
    // Auto-route: try providers with transcription keys in order
    for (const platform of ['groq', 'cloudflare'] as const) {
      const provider = getProvider(platform);
      if (!provider?.transcribe) continue;
      const keyRow = db.prepare('SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ? ORDER BY id LIMIT 1').get(platform, 'invalid') as any | undefined;
      if (!keyRow) continue;
      const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
      const modelForPlatform = platform === 'groq' ? modelId : '@cf/openai/whisper';
      candidates.push({ provider, apiKey, keyId: keyRow.id, modelId: modelForPlatform, displayName: `Whisper (${platform})`, platform });
    }
  }

  // Try each candidate until one succeeds
  let lastErr: any = null;
  for (const c of candidates) {
    try {
      const result = await c.provider.transcribe!(c.apiKey, file, fileName, c.modelId, {
        language: fields.language,
        prompt: fields.prompt,
        response_format: fields.response_format,
        temperature: fields.temperature ? parseFloat(fields.temperature) : undefined,
      });

      res.json(result);
      // Log success
      try {
        db.prepare('INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(c.platform, c.modelId, 'success', 0, 0, Date.now() - start, null);
      } catch { /* log best-effort */ }
      return;
    } catch (err: any) {
      lastErr = err;
      console.log(`[Proxy] Transcription error from ${c.displayName}: ${err.message.slice(0, 100)}`);
      // Log failure
      try {
        db.prepare('INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(c.platform, c.modelId, 'error', 0, 0, Date.now() - start, err.message?.slice(0, 200));
      } catch { /* log best-effort */ }
    }
  }

  res.status(502).json({
    error: { message: `All transcription providers failed. Last error: ${lastErr?.message ?? 'Unknown'}`, type: 'provider_error' },
  });
});

function logRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, error);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
