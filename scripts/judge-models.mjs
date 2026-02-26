const baseUrl = process.env.APP_BASE_URL || 'http://localhost:8080';
const provider = process.env.EVAL_PROVIDER || 'openrouter';
const candidateModels = (process.env.EVAL_MODELS || 'openai/gpt-5,openai/o3,openai/gpt-4.1')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const scenarios = [
  {
    name: 'anti_repeat',
    turns: [
      'I am overwhelmed but I love my work and friends are visiting.',
      'okay okay how are we doing right now if I make a break do you still listen to me',
      'before advice okay interesting yes what should I tell you',
      'I do not know what matters most, I have a lot of work and I love it.'
    ]
  },
  {
    name: 'decisive_short',
    turns: [
      'I keep procrastinating and I need a sharp plan for today.',
      'be decisive and short please',
      'I have 2 hours now what exactly should I do first'
    ]
  }
];

async function getJson(path, method = 'GET') {
  const response = await fetch(`${baseUrl}${path}`, { method });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

async function postJson(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTranscript(messages) {
  const assistant = messages.filter((item) => item.role === 'assistant').map((item) => item.text || '');
  const user = messages.filter((item) => item.role === 'user').map((item) => item.text || '');

  let score = 100;

  const normalized = assistant.map(normalize);
  let repeats = 0;
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i] && normalized[i] === normalized[i - 1]) repeats += 1;
  }
  score -= repeats * 28;

  const avgChars = assistant.length
    ? assistant.reduce((sum, item) => sum + item.length, 0) / assistant.length
    : 0;

  if (avgChars > 240) score -= 16;
  if (avgChars < 35) score -= 10;

  const genericFallbacks = [
    'let us continue',
    'what matters most for you this week'
  ];
  const genericHits = assistant.filter((msg) => {
    const lower = msg.toLowerCase();
    return genericFallbacks.some((needle) => lower.includes(needle));
  }).length;
  score -= genericHits * 24;

  const questionCount = assistant.filter((msg) => msg.includes('?')).length;
  if (questionCount === 0) score -= 12;
  if (questionCount > assistant.length) score -= 6;

  const userWordCount = user.join(' ').split(/\s+/).filter(Boolean).length;
  const aiWordCount = assistant.join(' ').split(/\s+/).filter(Boolean).length;
  if (aiWordCount > userWordCount * 0.9) score -= 8;

  return {
    score: Math.max(0, Math.round(score)),
    diagnostics: {
      repeats,
      avgChars: Math.round(avgChars),
      genericHits,
      aiWordCount,
      userWordCount
    }
  };
}

async function runScenario(model, memoryModel, scenario) {
  const created = await postJson('/api/session', {});
  if (!created.ok || !created.body?.sessionId) {
    throw new Error(`Failed to create session for ${scenario.name}`);
  }

  const sessionId = created.body.sessionId;
  const messages = [];

  for (const turn of scenario.turns) {
    messages.push({ role: 'user', text: turn });
    const response = await postJson('/api/chat', { sessionId, text: turn, channel: 'text' });

    if (!response.ok) {
      messages.push({ role: 'assistant', text: `[error:${response.status}] ${response.body?.error || 'unknown'}` });
      continue;
    }

    messages.push({ role: 'assistant', text: response.body?.answer || '' });
  }

  const judged = scoreTranscript(messages);
  return {
    scenario: scenario.name,
    ...judged,
    sample: messages.slice(-4)
  };
}

async function evaluateModel(model, memoryModel) {
  const config = await postJson('/api/ai-config', {
    provider,
    modelChat: model,
    modelMemory: memoryModel,
    probe: true
  });

  if (!config.ok || config.body?.probe?.ok === false) {
    return {
      model,
      ok: false,
      reason: config.body?.probe?.error || config.body?.error || `config_failed_${config.status}`
    };
  }

  const scenarioResults = [];
  for (const scenario of scenarios) {
    scenarioResults.push(await runScenario(model, memoryModel, scenario));
  }

  const avgScore = Math.round(
    scenarioResults.reduce((sum, item) => sum + item.score, 0) / scenarioResults.length
  );

  return {
    model,
    ok: true,
    avgScore,
    scenarioResults
  };
}

async function main() {
  const health = await getJson('/api/health');
  if (!health.ok) {
    throw new Error('Server is not reachable. Start it first with: npm run dev:clean');
  }

  const originalChatModel = health.body.aiModelChat;
  const originalMemoryModel = health.body.aiModelMemory;

  const results = [];
  for (const model of candidateModels) {
    process.stdout.write(`\n▶ Evaluating ${model} ...\n`);
    try {
      const result = await evaluateModel(model, originalMemoryModel);
      results.push(result);
      if (!result.ok) {
        process.stdout.write(`  ✖ skipped: ${result.reason}\n`);
        continue;
      }
      process.stdout.write(`  ✔ avg score: ${result.avgScore}\n`);
      for (const scenarioResult of result.scenarioResults) {
        process.stdout.write(`    - ${scenarioResult.scenario}: score=${scenarioResult.score}, repeats=${scenarioResult.diagnostics.repeats}, avgChars=${scenarioResult.diagnostics.avgChars}\n`);
      }
    } catch (error) {
      results.push({ model, ok: false, reason: error.message || String(error) });
      process.stdout.write(`  ✖ error: ${error.message || String(error)}\n`);
    }
  }

  const viable = results.filter((item) => item.ok);
  if (viable.length === 0) {
    await postJson('/api/ai-config', {
      provider,
      modelChat: originalChatModel,
      modelMemory: originalMemoryModel,
      probe: false
    });
    process.stdout.write('\nNo viable model found. Restored original model.\n');
    process.exit(1);
  }

  viable.sort((a, b) => b.avgScore - a.avgScore);
  const winner = viable[0];

  await postJson('/api/ai-config', {
    provider,
    modelChat: winner.model,
    modelMemory: originalMemoryModel,
    probe: false
  });

  process.stdout.write('\n===== MODEL JUDGE SUMMARY =====\n');
  for (const item of viable) {
    process.stdout.write(`${item.model}: ${item.avgScore}\n`);
  }
  process.stdout.write(`\nWinner: ${winner.model} (score ${winner.avgScore})\n`);
  process.stdout.write(`Runtime updated to winner model.\n`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
