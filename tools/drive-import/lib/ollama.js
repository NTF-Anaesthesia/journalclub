// Adapter with the same shape as the Workers AI binding (ai.run(model, { messages, max_tokens, temperature })), so the
// Worker's own summary code (aiSummary in worker/enrich.js) runs unchanged against a local ollama.
export function ollamaAi(model, base = 'http://127.0.0.1:11434', fetchFn = fetch) {
  return {
    async run(_ignored, { messages, max_tokens, temperature }) {
      const r = await fetchFn(`${base}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, think: false, options: { num_predict: max_tokens, temperature } }),
      });
      if (!r.ok) throw new Error(`ollama ${r.status}`);
      return { response: (await r.json()).message?.content || '' };
    },
  };
}
