/**
 * The heuristic's whole pattern list, kept small and explicit on purpose. A match means
 * only that some text reads like it addresses an AI reader (imperatives about instructions,
 * prompts or models). It is not a judgment of intent or danger, and the report says so.
 *
 * Each regex is linear (no nested quantifiers) and case-insensitive. Add or change patterns
 * here only; ids are stable and appear in reports.
 */
export interface HeuristicPattern {
  id: string;
  regex: RegExp;
}

export const HEURISTIC_WORDING =
  "pattern-matched text that reads like it targets an AI reader; heuristic match, not a judgment of intent or danger.";

const ANY = "(?:all |any |the |your |my |of )*";

export const HEURISTIC_PATTERNS: readonly HeuristicPattern[] = [
  { id: "ignore-previous", regex: new RegExp(`\\b(?:ignore|disregard|forget|override)\\s+${ANY}(?:previous|prior|above|earlier|preceding|existing|original)\\s+(?:instructions?|prompts?|messages?|directions?|rules|guidelines)\\b`, "gi") },
  { id: "forget-everything", regex: /\bforget\s+(?:everything|all\s+(?:of\s+)?(?:that|this|the\s+above))\b/gi },
  { id: "new-instructions", regex: /\b(?:new|updated|real|actual|hidden|secret)\s+(?:system\s+)?instructions?\s*:/gi },
  { id: "system-prompt", regex: /\b(?:reveal|print|output|repeat|show|leak|disclose)\s+(?:your|the)\s+(?:system\s+prompt|initial\s+prompt|instructions|hidden\s+prompt)\b/gi },
  { id: "if-you-are-ai", regex: /\bif\s+you\s+are\s+an?\s+(?:AI|LLM|large\s+language\s+model|language\s+model|AI\s+(?:assistant|agent|model)|assistant|chatbot|bot|crawler)\b/gi },
  { id: "addressed-to-ai", regex: /\b(?:dear\s+)?(?:AI|LLM|language\s+model|AI\s+(?:assistant|agent|model)|assistant|chatbot)s?\s*[,:]\s*(?:you\s+)?(?:must|should|need\s+to|will|please)\b/gi },
  { id: "you-are-now", regex: /\byou\s+are\s+now\s+(?:an?\s+|in\s+)?(?:\w+\s+)?(?:mode|AI|assistant|model|agent|DAN)\b/gi },
  { id: "do-not-tell-user", regex: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to|alert|notify)\s+the\s+(?:user|human|reader|operator)\b/gi },
  { id: "system-tag", regex: /(?:<\|?\s*(?:system|im_start|im_end)\s*\|?>|\[\/?(?:INST|SYS)\]|<<\/?SYS>>)/gi },
] as const;
