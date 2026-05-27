// In-memory sliding window rate limit tracker

interface Window {
  timestamps: number[];
  tokenCount: number;
  tokenTimestamps: { ts: number; tokens: number }[];
}

// Key format: "platform:modelId:keyId:type" where type is rpm|rpd|tpm|tpd
const windows = new Map<string, Window>();

function getWindow(key: string): Window {
  let w = windows.get(key);
  if (!w) {
    w = { timestamps: [], tokenCount: 0, tokenTimestamps: [] };
    windows.set(key, w);
  }
  return w;
}

function pruneTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter(ts => ts > cutoff);
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export function canMakeRequest(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();

  const rpmKey = `${platform}:${modelId}:${keyId}:rpm`;
  const effectiveRpm = getEffectiveLimit(rpmKey, limits.rpm);
  if (effectiveRpm !== null) {
    const w = getWindow(rpmKey);
    w.timestamps = pruneTimestamps(w.timestamps, MINUTE, now);
    if (w.timestamps.length >= effectiveRpm) return false;
  }

  const rpdKey = `${platform}:${modelId}:${keyId}:rpd`;
  const effectiveRpd = getEffectiveLimit(rpdKey, limits.rpd);
  if (effectiveRpd !== null) {
    const w = getWindow(rpdKey);
    w.timestamps = pruneTimestamps(w.timestamps, DAY, now);
    if (w.timestamps.length >= effectiveRpd) return false;
  }

  return true;
}

export function canUseTokens(
  platform: string,
  modelId: string,
  keyId: number,
  estimatedTokens: number,
  limits: { tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();

  const tpmKey = `${platform}:${modelId}:${keyId}:tpm`;
  const effectiveTpm = getEffectiveLimit(tpmKey, limits.tpm);
  if (effectiveTpm !== null) {
    const w = getWindow(tpmKey);
    w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - MINUTE);
    const used = w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    if (used + estimatedTokens > effectiveTpm) return false;
  }

  const tpdKey = `${platform}:${modelId}:${keyId}:tpd`;
  const effectiveTpd = getEffectiveLimit(tpdKey, limits.tpd);
  if (effectiveTpd !== null) {
    const w = getWindow(tpdKey);
    w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - DAY);
    const used = w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    if (used + estimatedTokens > effectiveTpd) return false;
  }

  return true;
}

export function recordRequest(platform: string, modelId: string, keyId: number) {
  const now = Date.now();

  const rpmKey = `${platform}:${modelId}:${keyId}:rpm`;
  getWindow(rpmKey).timestamps.push(now);

  const rpdKey = `${platform}:${modelId}:${keyId}:rpd`;
  getWindow(rpdKey).timestamps.push(now);
}

export function recordTokens(
  platform: string,
  modelId: string,
  keyId: number,
  tokens: number,
) {
  const now = Date.now();

  const tpmKey = `${platform}:${modelId}:${keyId}:tpm`;
  getWindow(tpmKey).tokenTimestamps.push({ ts: now, tokens });

  const tpdKey = `${platform}:${modelId}:${keyId}:tpd`;
  getWindow(tpdKey).tokenTimestamps.push({ ts: now, tokens });
}

// Dynamic limits: when a provider returns 413 with actual limit info (e.g.
// "Limit 8000, Requested 18677"), we learn the real limit and enforce it
// so the router never retries oversize requests against that model+key.
// Map key: "platform:modelId:keyId:type" (type = tpm|tpd|rpm|rpd)
const dynamicLimits = new Map<string, number>();

export function getEffectiveLimit(
  key: string,
  dbLimit: number | null,
): number | null {
  const dynamic = dynamicLimits.get(key);
  if (dynamic !== undefined) return dynamic;
  return dbLimit;
}

export function setDynamicLimit(key: string, limit: number) {
  // Only lower limits, never raise — the provider's reported limit is a ceiling.
  const existing = dynamicLimits.get(key);
  if (existing === undefined || limit < existing) {
    dynamicLimits.set(key, limit);
  }
}

// Cooldown: when a provider returns 429, block that model+key for a period
const cooldowns = new Map<string, number>(); // key -> expiry timestamp

export function setCooldown(platform: string, modelId: string, keyId: number, durationMs = 60_000) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  cooldowns.set(key, Date.now() + durationMs);
}

export function isOnCooldown(platform: string, modelId: string, keyId: number): boolean {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export function getRateLimitStatus(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();

  const rpmW = getWindow(`${platform}:${modelId}:${keyId}:rpm`);
  rpmW.timestamps = pruneTimestamps(rpmW.timestamps, MINUTE, now);

  const rpdW = getWindow(`${platform}:${modelId}:${keyId}:rpd`);
  rpdW.timestamps = pruneTimestamps(rpdW.timestamps, DAY, now);

  const tpmW = getWindow(`${platform}:${modelId}:${keyId}:tpm`);
  tpmW.tokenTimestamps = tpmW.tokenTimestamps.filter(t => t.ts > now - MINUTE);
  const tpmUsed = tpmW.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);

  return {
    rpm: { used: rpmW.timestamps.length, limit: limits.rpm },
    rpd: { used: rpdW.timestamps.length, limit: limits.rpd },
    tpm: { used: tpmUsed, limit: limits.tpm },
  };
}
