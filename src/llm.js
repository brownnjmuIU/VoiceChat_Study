import OpenAI from "openai";

// -----------------------------------------------------------------------------
// The one place that talks to the text model. OpenAI-compatible chat
// completions, which IU REALLMS (vLLM) accepts. Same pattern as Week 8.
// -----------------------------------------------------------------------------

export function createLlm(llmConfig) {
  if (llmConfig.mock) {
    // Deterministic stand-in for local dev and tests. Never enable on Render.
    return {
      model: llmConfig.model,
      async complete(messages) {
        const last = messages[messages.length - 1]?.content ?? "";
        return (
          `This is a mock reply. You said: ${last.slice(0, 200)}. ` +
          "Sharing data has benefits, like a more personal experience. It also has risks, " +
          "like your information being used in ways you did not expect."
        );
      },
    };
  }

  const client = new OpenAI({
    apiKey: llmConfig.apiKey,
    baseURL: llmConfig.baseURL,
    timeout: llmConfig.timeoutMs,
    maxRetries: 1,
  });

  return {
    model: llmConfig.model,
    async complete(messages) {
      const completion = await client.chat.completions.create({
        model: llmConfig.model,
        messages,
        ...(llmConfig.maxTokens && { max_tokens: llmConfig.maxTokens }),
        ...(llmConfig.temperature !== undefined && { temperature: llmConfig.temperature }),
        ...(llmConfig.reasoningEffort && { reasoning_effort: llmConfig.reasoningEffort }),
      });
      const reply = completion.choices?.[0]?.message?.content?.trim();
      if (!reply) {
        const err = new Error("Empty completion");
        err.status = 502;
        throw err;
      }
      return reply;
    },
  };
}

/** Upstream failure -> text safe to show in the chat (no key, URL or stack). */
export function describeUpstreamError(err, model) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) {
    return { status: 503, error: "The assistant is busy right now. Wait a moment and try again." };
  }
  if (status === 400 || status === 401 || status === 403) {
    console.error(`LLM provider rejected the request (${status}). Check LLM_API_KEY / LLM_MODEL.`);
    return { status: 502, error: "The assistant is unavailable right now." };
  }
  if (status === 404) {
    console.error(`LLM model "${model}" not found at provider. Check LLM_MODEL.`);
    return { status: 502, error: "The assistant is unavailable right now." };
  }
  if (err?.name === "APIConnectionTimeoutError" || err?.code === "ETIMEDOUT") {
    return { status: 504, error: "The assistant took too long to answer. Please try again." };
  }
  return { status: 502, error: "Something went wrong reaching the assistant. Please try again." };
}
