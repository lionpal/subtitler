// Google Gemini, asked for JSON that matches a schema ("structured output").
// Docs: https://ai.google.dev/gemini-api/docs/structured-output

import { ApiError, errorFromResponse, withRetries } from "../http.ts";
import type { Translator } from "./provider.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export function geminiTranslator(apiKey: string, model = DEFAULT_GEMINI_MODEL, onRetry?: (message: string) => void): Translator {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  async function sendOnce(instructions: string, request: string, schema: object, webSearch: boolean): Promise<unknown> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: "user", parts: [{ text: request }] }],
        tools: webSearch ? [{ google_search: {} }] : undefined,
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await errorFromResponse("Gemini", response);

    const body = await response.json();
    const text = body.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
    if (!text) {
      const reason = body.candidates?.[0]?.finishReason ?? body.promptFeedback?.blockReason;
      throw new ApiError("Gemini", reason ? `empty answer (${reason})` : "empty answer", 502);
    }
    try {
      return JSON.parse(text);
    } catch {
      // A cut-off answer is not valid JSON. Asking again usually works.
      throw new ApiError("Gemini", "the answer is not valid JSON", 502);
    }
  }

  return {
    name: model,
    generateJson: (instructions, request, schema, options) =>
      withRetries(() => sendOnce(instructions, request, schema, options?.webSearch ?? false), onRetry),
  };
}
