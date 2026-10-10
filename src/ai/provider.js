class AIProviderError extends Error {
  constructor(message, code = 'AI_PROVIDER_ERROR') {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
  }
}

function createAIProvider(env = process.env, fetchImpl = globalThis.fetch) {
  const rawBase = String(env.AI_BASE_URL || '').trim();
  let baseUrl = null;
  if (rawBase) {
    let parsed;
    try { parsed = new URL(rawBase); } catch { throw new Error('AI_BASE_URL must be a valid http or https URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('AI_BASE_URL must use http or https.');
    if (parsed.username || parsed.password) throw new Error('AI_BASE_URL must not contain embedded credentials.');
    baseUrl = parsed.toString().replace(/\/$/u, '');
  }
  const model = String(env.AI_MODEL || '').trim();
  const apiKey = String(env.AI_API_KEY || '').trim();
  const timeoutMs = Math.max(1000, Math.min(Number(env.AI_TIMEOUT_MS) || 45000, 180000));

  return {
    available: Boolean(baseUrl && model),
    async completeJSON({ system, user, images = [], signal } = {}) {
      if (!baseUrl || !model) {
        throw new AIProviderError('AI is not configured. Set AI_BASE_URL and AI_MODEL before requesting agent processing.', 'AI_NOT_CONFIGURED');
      }
      const content = [{ type: 'text', text: String(user || '') }];
      for (const image of images) {
        if (!/^data:image\/(png|jpeg|webp|gif);base64,/iu.test(image)) continue;
        content.push({ type: 'image_url', image_url: { url: image, detail: 'high' } });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('AI request timed out.')), timeoutMs);
      const abort = () => controller.abort(signal.reason);
      if (signal) signal.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: String(system || 'Return only a JSON object.') },
              { role: 'user', content },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          throw new AIProviderError(`AI provider returned HTTP ${response.status}: ${detail}`);
        }
        const payload = await response.json();
        const message = payload?.choices?.[0]?.message?.content;
        const text = typeof message === 'string'
          ? message
          : Array.isArray(message) ? message.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : '';
        if (!text) throw new AIProviderError('AI provider response did not include JSON text.', 'AI_INVALID_RESPONSE');
        const cleaned = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
        try { return JSON.parse(cleaned); } catch {
          throw new AIProviderError('AI provider returned malformed JSON; the document remains unreviewed.', 'AI_INVALID_JSON');
        }
      } catch (error) {
        if (error instanceof AIProviderError) throw error;
        if (controller.signal.aborted) {
          throw new AIProviderError('AI provider request timed out or was cancelled.', 'AI_TIMEOUT');
        }
        throw new AIProviderError(`AI provider could not be reached: ${error.message}`);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
      }
    },
  };
}

module.exports = { createAIProvider, AIProviderError };
