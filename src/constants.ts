export const APP_NAME = "transx";
export const PACKAGE_NAME = "@gushengcode/transx-cli";
export const CONFIG_VERSION = 1;
export const DEFAULT_SOURCE_LANGUAGE = "auto";
export const DEFAULT_TARGET_LANGUAGE = "ZH";
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_RETRIES = 2;
export const RETRY_BASE_DELAY_MS = 300;
export const URL_KEY_PLACEHOLDER = "{key}";
// DLX 服务地址固定，用户只需提供 API Key。
export const DLX_URL_TEMPLATE = "https://api.deeplx.org/{key}/translate";
export const HISTORY_MAX_AGE_DAYS = 30;
export const HISTORY_MAX_BYTES = 100 * 1024 * 1024;
export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const HISTORY_LOCK_TIMEOUT_MS = 5_000;
export const HISTORY_STALE_LOCK_MS = 30_000;

export const ENV_API_KEY = "DLX_API_KEY";
export const HTTP_USER_AGENT = "Mozilla/5.0 (compatible; TransX; +https://github.com/GuSheng107/transx-cli)";

export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export const TRANSLATION_TEXT_MAX_CHARS = 1_500;
export const FILE_TOTAL_TEXT_MAX_CHARS = 100_000;
export const FILE_MAX_TRANSLATION_UNITS = 500;
export const FILE_REQUEST_DELAY_MS = 200;
export const FILE_TRANSLATION_CONCURRENCY = 5;
export const OFFICE_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;
