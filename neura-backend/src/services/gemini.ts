import axios from "axios";
import { Readable } from "stream";
import config from "../config";

interface GeminiResponseChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
}

/**
 * Service for interacting with the Google Gemini API
 */
class GeminiService {
  private baseUrl = "https://generativelanguage.googleapis.com/v1";
  private apiKey: string;

  constructor() {
    this.apiKey = config.geminiApiKey;
  }

  /**
   * Create a streaming response from Gemini Live API
   * @param prompt User prompt text
   * @returns Readable stream with response chunks
   */
  async streamChat(prompt: string): Promise<Readable> {
    // Create a readable stream to push data to the WebSocket
    const outputStream = new Readable({
      read() {}, // No-op implementation required
    });

    let buffer = ""; // Buffer for incomplete JSON chunks from Gemini

    try {
      const model = "gemini-2.0-flash-lite-001"; // Use appropriate model
      const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`; // Use alt=sse for Server-Sent Events

      const requestBody = {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          topP: 0.8,
          topK: 40,
        },
      };

      // Make streaming request with axios
      const response = await axios({
        method: "post",
        url,
        data: requestBody,
        responseType: "stream",
      });

      // Process the stream from Gemini AS IT ARRIVES
      response.data.on("data", (chunk: Buffer) => {
        buffer += chunk.toString(); // Append new data

        let newlineIndex;
        // Process buffer line by line (assuming newline-delimited JSON from Gemini stream)
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.substring(0, newlineIndex).trim();
          buffer = buffer.substring(newlineIndex + 1); // Remove processed line

          if (line.startsWith("data: ")) {
            // Handle potential SSE "data: " prefix
            const jsonData = line.substring(5).trim();
            if (jsonData.length > 0) {
              try {
                const data = JSON.parse(jsonData) as GeminiResponseChunk;
                if (
                  data.candidates &&
                  data.candidates[0]?.content?.parts?.[0]?.text
                ) {
                  const text = data.candidates[0].content.parts[0].text;
                  outputStream.push(text); // Push extracted text immediately
                }
              } catch (parseError) {
                console.error("Error parsing Gemini stream chunk:", parseError);
                console.error("Problematic JSON data:", jsonData);
                // Decide if we should emit an error on outputStream or just log
              }
            }
          } else if (line.length > 0) {
            console.warn("Received non-data line from Gemini stream:", line);
          }
        }
        // Keep remaining buffer content for the next chunk
      });

      // Handle the end of the Gemini stream
      response.data.on("end", () => {
        console.log("Gemini stream ended.");
        outputStream.push(null); // Signal the end of our output stream
      });

      // Handle errors from the Gemini stream
      response.data.on("error", (err: Error) => {
        console.error("Gemini stream error:", err);
        outputStream.emit("error", err); // Propagate the error
        outputStream.push(null);
      });
    } catch (error) {
      console.error("Error initiating Gemini streaming request:", error);
      if (axios.isAxiosError(error)) {
        console.error(
          "Axios error details:",
          JSON.stringify(error.toJSON(), null, 2)
        );
        if (error.response) {
          console.error("Axios response data:", error.response.data);
          console.error("Axios response status:", error.response.status);
        }
      }
      outputStream.emit("error", error); // Emit error on our stream
      outputStream.push(null);
    }

    return outputStream; // Return the stream that WebSocket will read from
  }
}

export default new GeminiService();
