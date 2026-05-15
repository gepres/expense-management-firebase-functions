// Fuente única de tipos de media soportados (ROADMAP § A.1).
// Antes duplicado en media-downloader.ts y transcription.service.ts.

export const AUDIO_MIME_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "mp4",
  "audio/amr": "amr",
  "audio/wav": "wav",
};

export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export function isValidAudioType(mimeType: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUDIO_MIME_EXT, mimeType);
}

export function isValidImageType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.includes(mimeType);
}

export function audioExtensionFor(mimeType: string): string {
  return AUDIO_MIME_EXT[mimeType] || "ogg";
}
