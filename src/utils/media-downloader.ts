import axios from "axios";
import * as functions from "firebase-functions/v1";

export class MediaDownloader {
  static async downloadTwilioMedia(
    mediaUrl: string,
    accountSid?: string,
    authToken?: string
  ): Promise<{ base64: string; mimeType: string } | null> {
    try {
      const sid = accountSid || functions.config().twilio?.account_sid || process.env.TWILIO_ACCOUNT_SID;
      const token = authToken || functions.config().twilio?.auth_token || process.env.TWILIO_AUTH_TOKEN;

      if (!sid || !token) {
        throw new Error("Twilio credentials not configured");
      }

      functions.logger.info(`Downloading media from: ${mediaUrl}`);

      const response = await axios.get(mediaUrl, {
        responseType: "arraybuffer",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        },
        timeout: 30000,
      });

      const base64 = Buffer.from(response.data, "binary").toString("base64");
      const mimeType = response.headers["content-type"] || "image/jpeg";

      functions.logger.info(`Media downloaded successfully. Type: ${mimeType}, Size: ${base64.length} bytes`);

      return {
        base64,
        mimeType,
      };
    } catch (error) {
      functions.logger.error("Error downloading Twilio media:", error);
      return null;
    }
  }

  static isValidImageType(mimeType: string): boolean {
    const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    return validTypes.includes(mimeType);
  }
}
