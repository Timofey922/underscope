// Shared Gemini client. Files under api/_lib are not exposed as Vercel routes.
// GEMINI_USE_VERTEX=true -> Vertex AI with an API key (billed to the Google Cloud project);
// otherwise -> Gemini Developer API (AI Studio). Same models and calls either way.
import { GoogleGenAI } from '@google/genai';

export function geminiClient(): { ai: GoogleGenAI; model: string } | null {
  const apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) return null;
  const vertexai = process.env.GEMINI_USE_VERTEX === 'true';
  return { ai: new GoogleGenAI({ apiKey, vertexai }), model };
}
