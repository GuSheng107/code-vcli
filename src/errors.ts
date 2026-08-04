export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "CONFIG_NOT_INITIALIZED"
  | "CONFIG_INVALID"
  | "NETWORK_ERROR"
  | "API_HTTP_ERROR"
  | "API_RESPONSE_INVALID"
  | "INSTALL_ERROR"
  | "UPDATE_ERROR"
  | "HISTORY_ERROR"
  | "CANCELLED"
  | "FILE_READ_ERROR"
  | "FILE_FORMAT_UNSUPPORTED"
  | "FILE_TOO_LARGE"
  | "FILE_TEXT_EMPTY"
  | "FILE_DEPENDENCY_MISSING"
  | "FILE_WRITE_ERROR"
  | "OCR_NOT_INSTALLED"
  | "OCR_INSTALL_DECLINED"
  | "OCR_DOWNLOAD_FAILED"
  | "OCR_INSTALL_FAILED"
  | "OCR_RUNTIME_MISSING"
  | "OCR_MODEL_INVALID"
  | "OCR_INITIALIZATION_FAILED"
  | "OCR_RECOGNITION_FAILED"
  | "OCR_TEXT_EMPTY"
  | "IMAGE_READ_ERROR"
  | "IMAGE_FORMAT_UNSUPPORTED"
  | "IMAGE_TOO_LARGE";

export class TransxError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;

  constructor(code: ErrorCode, message: string, exitCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransxError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function toTransxError(error: unknown): TransxError {
  if (error instanceof TransxError) {
    return error;
  }
  if (error instanceof Error) {
    return new TransxError("NETWORK_ERROR", error.message, 4, { cause: error });
  }
  return new TransxError("NETWORK_ERROR", "发生未知错误", 4);
}
