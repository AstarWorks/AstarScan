/**
 * Shared parser for the chain-of-thought (CoT) prompts used by
 * llm-frame-validator / llm-card-pair / llm-best-frame.
 *
 * All three services prompt Gemma 4 to emit:
 *
 *   理由: <free-form explanation, 1-3 sentences>
 *   答え: <short answer>
 *
 * `parseCoTAnswer(raw)` extracts both halves. If the model fails to
 * follow the format the caller falls back to its v1 single-token
 * regex (digit / yes-no). The unparsed `raw` is always preserved so
 * the UI can display it for debugging — silent fall-back is what
 * hid the previous prompt quality problems.
 */

export interface CoTParsed {
  /** The model's reasoning text, or the whole `raw` if the parser
   *  couldn't find a `理由:` line. */
  readonly reasoning: string
  /** The text after `答え:` (trimmed), or empty string if absent. */
  readonly answer: string
}

export function parseCoTAnswer(raw: string): CoTParsed {
  const answerMatch = raw.match(/答え\s*[:：]\s*([^\n]+)/)
  const answer = answerMatch?.[1]?.trim() ?? ''
  const reasoningMatch = raw.match(/理由\s*[:：]\s*([\s\S]+?)(?:\n\s*答え|$)/)
  const reasoning = reasoningMatch?.[1]?.trim() ?? raw.trim()
  return { reasoning, answer }
}
