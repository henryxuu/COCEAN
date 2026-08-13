export { MediaScanError } from "./errors.js";
export {
  classifyAudioPath,
  isSupportedAudioPath,
  KNOWN_UNSUPPORTED_AUDIO_EXTENSIONS,
  scanMediaFile,
  scanMediaFiles,
  SUPPORTED_AUDIO_EXTENSIONS,
} from "./scanner.js";
export type { AudioPathClassification } from "./scanner.js";
export type {
  MediaScanErrorCode,
  MediaScanOutcome,
  MediaScanStage,
  ScanMediaFileOptions,
  SerializedMediaScanError,
} from "./types.js";
