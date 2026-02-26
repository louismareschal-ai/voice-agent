const baseUrl = process.env.APP_BASE_URL || 'http://localhost:8080';

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

function fail(message, details) {
  console.error(`❌ ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function pass(message) {
  console.log(`✅ ${message}`);
}

let health = await getJson('/api/health');
if (!health.ok) fail('Health endpoint failed', health);

if (health.body.aiProvider !== 'openrouter') {
  await postJson('/api/ai-config', {
    provider: 'openrouter',
    modelChat: 'openai/gpt-4.1',
    modelMemory: 'openai/gpt-4.1-mini',
    probe: false
  });
  health = await getJson('/api/health');
}

pass(`Health OK (${health.body.aiProvider}, enabled=${health.body.aiEnabled})`);

const readiness = await getJson('/api/demo-readiness');
if (!readiness.ok || !readiness.body.ready) fail('Demo readiness failed', readiness);
pass('Demo readiness OK');

const privacy = await getJson('/api/privacy-proof');
if (!privacy.ok || privacy.body.storage !== 'in-memory-only') {
  fail('Privacy proof failed', privacy);
}
pass('Privacy proof OK');

const probe = await getJson('/api/ai-probe', 'POST');
if (health.body.aiEnabled && !probe.ok) {
  fail('AI probe failed while AI is enabled', probe.body);
}

if (!health.body.aiEnabled) {
  pass('AI disabled: fallback mode expected');
} else {
  pass('AI probe OK');
}

console.log('🎯 Smoke test complete');
