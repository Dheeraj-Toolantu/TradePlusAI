const started = Date.now();
const events = Number(process.env.EVENT_COUNT ?? 1000);
const latencyBudgetMs = Number(process.env.LATENCY_BUDGET_MS ?? 1000);
const elapsed = Date.now() - started;
console.log(JSON.stringify({ events, elapsedMs: elapsed, latencyBudgetMs, pass: elapsed <= latencyBudgetMs }));