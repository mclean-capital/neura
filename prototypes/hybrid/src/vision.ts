import { GoogleGenAI } from '@google/genai';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
  console.error('GOOGLE_API_KEY is required for vision — set it in .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

export async function analyzeFrame(
  base64Jpeg: string,
  focus?: string,
): Promise<string> {
  const prompt = focus
    ? `Describe what you see, focusing on: ${focus}. Be concise (1-2 sentences).`
    : 'Describe what you see concisely (1-2 sentences).';

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } },
          { text: prompt },
        ],
      },
    ],
  });

  return response.text || 'Unable to analyze image.';
}
