/**
 * Base interface every model provider must implement.
 * Swap providers by subclassing this and returning a different instance
 * from ModelProviderFactory — no other code changes required.
 */
class AIModelProvider {
  /** Unique model identifier, e.g. "qwen2.5:1.5b-instruct" */
  get name() { throw new Error('AIModelProvider.name not implemented'); }

  /** "local" | "cloud" | "hybrid" | "mock" */
  get family() { throw new Error('AIModelProvider.family not implemented'); }

  /**
   * @returns {{
   *   supportsToolCalling: boolean,
   *   supportsJsonSchema: boolean,
   *   supportsStreaming: boolean,
   *   supportsVision: boolean,
   *   maxContextTokens: number,
   *   recommendedTemperature: number
   * }}
   */
  get capabilities() { throw new Error('AIModelProvider.capabilities not implemented'); }

  /**
   * Generate a response.
   * @param {{
   *   systemPrompt: string,
   *   messages: Array<{role: string, content: string}>,
   *   tools: Array,
   *   temperature?: number,
   *   maxTokens?: number,
   *   metadata?: object
   * }} input
   * @returns {Promise<{type: 'assistant_message'|'tool_call'|'clarification'|'error', content?: string, toolName?: string, arguments?: object, question?: string, message?: string}>}
   */
  async generate(input) { throw new Error('AIModelProvider.generate not implemented'); }

  /**
   * Optional streaming support.
   * @param {object} input
   * @returns {AsyncIterable<{delta: string}>}
   */
  async *stream(input) { throw new Error('Streaming not supported by this provider'); }

  /**
   * @returns {Promise<{healthy: boolean, modelAvailable?: boolean, error?: string}>}
   */
  async healthCheck() { throw new Error('AIModelProvider.healthCheck not implemented'); }
}

module.exports = { AIModelProvider };
