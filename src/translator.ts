import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_SOURCE_LANGUAGE,
  HTTP_USER_AGENT,
  RETRY_BASE_DELAY_MS,
  TRANSLATION_TEXT_MAX_CHARS,
  URL_KEY_PLACEHOLDER,
} from "./constants.js";
import { TransxError } from "./errors.js";
import type { ResolvedConfig } from "./config.js";

export interface TranslationRequest {
  text: string;
  targetLang: string;
  sourceLang?: string;
  timeoutMs?: number;
}

export interface TranslationResult {
  data: string;
  sourceLang: string;
  targetLang: string;
  provider: "dlx";
}

interface DlxResponse {
  code?: number;
  data?: unknown;
  message?: string;
}

function isDlxResponse(value: unknown): value is DlxResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if ("code" in value && value.code !== undefined && typeof value.code !== "number") return false;
  if ("message" in value && value.message !== undefined && typeof value.message !== "string") return false;
  return true;
}

export type FetchLike = typeof fetch;

export function buildEndpoint(urlTemplate: string, apiKey: string): string {
  return urlTemplate.replaceAll(URL_KEY_PLACEHOLDER, encodeURIComponent(apiKey));
}

function shouldRetry(status: number): boolean {
  return status >= 500;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function translate(
  config: ResolvedConfig,
  request: TranslationRequest,
  fetchImpl: FetchLike = fetch,
): Promise<TranslationResult> {
  const text = request.text;
  const targetLang = request.targetLang.trim().toUpperCase();
  const sourceLang = request.sourceLang?.trim() || DEFAULT_SOURCE_LANGUAGE;

  if (!text.trim()) {
    throw new TransxError("INVALID_ARGUMENT", "待翻译文本不能为空", 2);
  }
  if (!targetLang) {
    throw new TransxError("INVALID_ARGUMENT", "必须通过 --to 指定目标语言", 2);
  }
  if ([...text].length > TRANSLATION_TEXT_MAX_CHARS) {
    throw new TransxError(
      "INVALID_ARGUMENT",
      `文本超过 DLX 单次上限 ${TRANSLATION_TEXT_MAX_CHARS} 字符，请分段或分批翻译`,
      2,
    );
  }
  const payload: Record<string, string> = {
    text,
    source_lang: sourceLang,
    target_lang: targetLang,
  };
  const endpoint = buildEndpoint(config.urlTemplate, config.apiKey);
  const timeoutMs = request.timeoutMs || config.timeoutMs;
  let lastNetworkError: unknown;

  // 仅对网络层错误（超时、连接失败）和 HTTP 5xx 重试；HTTP 429 直接返回。
  // 业务层错误（TransxError）一律不重试，避免对无效响应或配置问题反复请求。
  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": HTTP_USER_AGENT },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (attempt < DEFAULT_MAX_RETRIES && shouldRetry(response.status)) {
          await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw new TransxError("API_HTTP_ERROR", `DLX 请求失败，HTTP ${response.status}`, 5);
      }

      let body: DlxResponse;
      try {
        const parsed: unknown = await response.json();
        if (!isDlxResponse(parsed)) {
          throw new TransxError("API_RESPONSE_INVALID", "DLX 返回的 JSON 结构无效", 6);
        }
        body = parsed;
      } catch (error) {
        throw new TransxError("API_RESPONSE_INVALID", "DLX 返回的不是有效 JSON", 6, {
          cause: error,
        });
      }

      if (body.code !== undefined && body.code !== 200) {
        throw new TransxError(
          "API_HTTP_ERROR",
          body.message ? `DLX 返回错误：${body.message}` : `DLX 返回错误码 ${body.code}`,
          5,
        );
      }
      if (typeof body.data !== "string") {
        throw new TransxError("API_RESPONSE_INVALID", "DLX 响应缺少字符串字段 data", 6);
      }

      return {
        data: body.data,
        sourceLang,
        targetLang,
        provider: "dlx",
      };
    } catch (error) {
      // TransxError 是业务层错误（HTTP 错误码、响应格式问题等），直接抛出不重试。
      if (error instanceof TransxError) {
        throw error;
      }
      // 其余视为网络层错误（超时、DNS、连接重置等），记录后重试。
      lastNetworkError = error;
      if (attempt < DEFAULT_MAX_RETRIES) {
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const isTimeout = lastNetworkError instanceof Error && lastNetworkError.name === "AbortError";
  throw new TransxError(
    "NETWORK_ERROR",
    isTimeout ? `DLX 请求超时（${timeoutMs}ms）` : "无法连接 DLX 服务",
    4,
    { cause: lastNetworkError },
  );
}
