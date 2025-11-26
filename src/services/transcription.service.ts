import OpenAI from "openai";
import * as functions from "firebase-functions/v1";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export class TranscriptionService {
  private client: OpenAI;

  constructor() {
    const apiKey = functions.config().openai?.api_key || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OpenAI API key not configured");
    }
    this.client = new OpenAI({ apiKey });
  }

  async transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string | null> {
    let tempFilePath: string | null = null;

    try {
      // Create temporary file
      const extension = this.getExtensionFromMimeType(mimeType);
      tempFilePath = path.join(os.tmpdir(), `audio_${Date.now()}.${extension}`);

      // Write buffer to temporary file
      fs.writeFileSync(tempFilePath, audioBuffer);

      functions.logger.info(`Transcribing audio file: ${tempFilePath}`);

      // Transcribe using Whisper
      const transcription = await this.client.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: "whisper-1",
        language: "es", // Spanish
      });

      functions.logger.info("Transcription successful:", transcription.text);

      return transcription.text;
    } catch (error) {
      functions.logger.error("Error transcribing audio:", error);
      return null;
    } finally {
      // Clean up temporary file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          functions.logger.warn("Failed to cleanup temp file:", cleanupError);
        }
      }
    }
  }

  private getExtensionFromMimeType(mimeType: string): string {
    const mimeToExt: { [key: string]: string } = {
      "audio/ogg": "ogg",
      "audio/mpeg": "mp3",
      "audio/mp4": "mp4",
      "audio/amr": "amr",
      "audio/wav": "wav",
    };

    return mimeToExt[mimeType] || "ogg";
  }

  static isValidAudioType(mimeType: string): boolean {
    const validTypes = [
      "audio/ogg",
      "audio/mpeg",
      "audio/mp4",
      "audio/amr",
      "audio/wav",
    ];
    return validTypes.includes(mimeType);
  }
}
