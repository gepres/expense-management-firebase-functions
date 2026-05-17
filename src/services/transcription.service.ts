import OpenAI from "openai";
import * as logger from "firebase-functions/logger";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { audioExtensionFor } from "../utils/media-types";
import { transcribeModel } from "../config/models";
import { recordUsage, UsageContext } from "./usage.service";

export class TranscriptionService {
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OpenAI API key not configured");
    }
    this.client = new OpenAI({ apiKey });
  }

  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string,
    usageCtx?: Partial<UsageContext>
  ): Promise<string | null> {
    let tempFilePath: string | null = null;

    try {
      // Create temporary file
      const extension = this.getExtensionFromMimeType(mimeType);
      tempFilePath = path.join(os.tmpdir(), `audio_${Date.now()}.${extension}`);

      // Write buffer to temporary file
      fs.writeFileSync(tempFilePath, audioBuffer);

      logger.info(`Transcribing audio file: ${tempFilePath}`);

      // Transcribe using Whisper
      const transcription = await this.client.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        // Modelo por env (default gpt-4o-mini-transcribe). Ver
        // src/config/models.ts § OpenAI.
        model: transcribeModel(),
        language: "es", // Spanish
      });

      logger.info("Transcription successful:", transcription.text);

      // La API no devuelve duración; estimación gruesa por tamaño del
      // buffer (audio WhatsApp ≈ Opus ~24 kbps ≈ 3000 bytes/s). Solo para
      // estimar costo (best-effort), clamp a 10 min.
      const estSeconds = Math.min(
        600,
        Math.max(1, Math.round(audioBuffer.length / 3000))
      );
      void recordUsage({
        provider: "openai",
        model: transcribeModel(),
        units: estSeconds,
        unitType: "audio_seconds",
        userId: usageCtx?.userId ?? null,
        scope: usageCtx?.scope ?? "user",
        feature: usageCtx?.feature ?? "whatsapp_voice_transcription",
      });

      return transcription.text;
    } catch (error) {
      logger.error("Error transcribing audio:", error);
      return null;
    } finally {
      // Clean up temporary file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          logger.warn("Failed to cleanup temp file:", cleanupError);
        }
      }
    }
  }

  private getExtensionFromMimeType(mimeType: string): string {
    return audioExtensionFor(mimeType);
  }
}
