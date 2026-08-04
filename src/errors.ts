export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "CONFIG_NOT_INITIALIZED"
  | "CONFIG_INVALID"
  | "INSTALL_ERROR"
  | "UPDATE_ERROR"
  | "CANCELLED"
  | "IMAGE_READ_ERROR"
  | "IMAGE_FORMAT_UNSUPPORTED"
  | "IMAGE_TOO_LARGE"
  | "MODEL_NOT_INSTALLED"
  | "MODEL_INSTALL_DECLINED"
  | "MODEL_DOWNLOAD_FAILED"
  | "MODEL_INSTALL_FAILED"
  | "MODEL_RUNTIME_MISSING"
  | "MODEL_INITIALIZATION_FAILED"
  | "MODEL_RECOGNITION_FAILED"
  | "MODEL_TEXT_EMPTY";

export class VcliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;

  constructor(code: ErrorCode, message: string, exitCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "VcliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function toVcliError(error: unknown): VcliError {
  if (error instanceof VcliError) {
    return error;
  }
  if (error instanceof Error) {
    return new VcliError("MODEL_RECOGNITION_FAILED", error.message, 4, { cause: error });
  }
  return new VcliError("MODEL_RECOGNITION_FAILED", "发生未知错误", 4);
}
