const WORKFLOW_MARKER = "#workflow";

export interface PromptParseResult {
  valid: boolean;
  cleanedPrompt: string;
  normalizedPrompt: string;
}

/**
 * Parse a workflow prompt, detecting the #workflow marker.
 *
 * The marker can appear at:
 * - Start: "#workflow Implement feature X"
 * - End: "Implement feature X #workflow"
 *
 * Returns the cleaned prompt (without the marker) if valid.
 */
export function parseWorkflowPrompt(input: string): PromptParseResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { valid: false, cleanedPrompt: "", normalizedPrompt: "" };
  }

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const lastToken = tokens[tokens.length - 1];

  if (firstToken === WORKFLOW_MARKER) {
    const cleanedPrompt = trimmed.replace(/^#workflow(?=\s|$)\s*/, "");
    return {
      valid: true,
      cleanedPrompt,
      normalizedPrompt: cleanedPrompt.trim(),
    };
  }

  if (lastToken === WORKFLOW_MARKER) {
    const cleanedPrompt = trimmed.replace(/\s*#workflow$/, "");
    return {
      valid: true,
      cleanedPrompt,
      normalizedPrompt: cleanedPrompt.trim(),
    };
  }

  return {
    valid: false,
    cleanedPrompt: trimmed,
    normalizedPrompt: trimmed,
  };
}

/**
 * Check if a string starts with the workflow marker.
 */
export function startsWithWorkflowMarker(text: string): boolean {
  return text.trim().split(/\s+/)[0] === WORKFLOW_MARKER;
}

/**
 * Check if a string ends with the workflow marker.
 */
export function endsWithWorkflowMarker(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  return tokens[tokens.length - 1] === WORKFLOW_MARKER;
}
