// ElevenLabs Scribe, which returns the time of every word.
// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert

import { ApiError, errorFromResponse, withRetries } from "../http.ts";
import type { Word } from "../srt.ts";
import type { SpeechToText, Transcript } from "./provider.ts";

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
const SUBSCRIPTION_ENDPOINT = "https://api.elevenlabs.io/v1/user/subscription";
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000; // an hour of audio usually takes under a minute
export const DEFAULT_SCRIBE_MODEL = "scribe_v2";

// Measured on a real account: an 8-hour series used 9,495 credits in October 2026, and three
// one-minute clips used 60. The pricing page says 330 a minute, which did not match.
const CREDITS_PER_MINUTE = 20;

// Monthly price in dollars and credits included, from https://elevenlabs.io/pricing in October 2026.
const PLANS: Record<string, { dollars: number; credits: number }> = {
  starter: { dollars: 6, credits: 30_000 },
  creator: { dollars: 22, credits: 121_000 },
  pro: { dollars: 99, credits: 600_000 },
  scale: { dollars: 299, credits: 1_800_000 },
  business: { dollars: 990, credits: 6_000_000 },
};

export function elevenLabsScribe(apiKey: string, model = DEFAULT_SCRIBE_MODEL): SpeechToText {
  return {
    name: `ElevenLabs Scribe ${model.replace("scribe_", "")}`,
    transcribe: (audio, fileName, options) =>
      withRetries(() => sendOnce(apiKey, model, audio, fileName, options.language), options.onRetry),
    async costEstimator() {
      const plan = await fetchPlan(apiKey);
      return (seconds) => describeCost(seconds, plan);
    },
  };
}

async function sendOnce(apiKey: string, model: string, audio: Blob, fileName: string, language?: string): Promise<Transcript> {
  const form = new FormData();
  form.set("model_id", model);
  form.set("timestamps_granularity", "word");
  form.set("tag_audio_events", "false");
  if (language) form.set("language_code", language);
  form.set("file", audio, fileName);

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await errorFromResponse("ElevenLabs", response);

  const answer = (await response.json()) as { language_code: string; words: Word[] };
  if (!Array.isArray(answer.words)) throw new ApiError("ElevenLabs", "no word timings in the answer", response.status);
  return { language: answer.language_code, words: answer.words };
}

type Plan = {
  tier: string; // "creator", "pro" and so on
  creditsLeft: number;
};

// Your plan and remaining credits. Null if the key is not allowed to read them; the estimate then
// shows credits only.
async function fetchPlan(apiKey: string): Promise<Plan | null> {
  try {
    const response = await fetch(SUBSCRIPTION_ENDPOINT, {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const subscription = await response.json();
    return { tier: String(subscription.tier), creditsLeft: subscription.character_limit - subscription.character_count };
  } catch {
    return null;
  }
}

// e.g. "about 2,360 credits ($0.43 on the Creator plan, 161,619 left)"
function describeCost(seconds: number, plan: Plan | null): string {
  const credits = Math.ceil((seconds / 60) * CREDITS_PER_MINUTE);
  let text = `about ${credits.toLocaleString("en-US")} ElevenLabs credits`;
  if (plan === null) return text;

  const details: string[] = [];
  const planName = Object.keys(PLANS).find((name) => plan.tier.startsWith(name));
  if (planName) {
    const { dollars, credits: included } = PLANS[planName];
    const cost = (credits / included) * dollars;
    const title = planName[0].toUpperCase() + planName.slice(1);
    details.push(`${cost < 0.01 ? "under $0.01" : `$${cost.toFixed(2)}`} on the ${title} plan`);
  }
  details.push(`${plan.creditsLeft.toLocaleString("en-US")} left`);
  text += ` (${details.join(", ")})`;

  if (credits > plan.creditsLeft) text += ", more than you have left";
  return text;
}
