const apiUrl = process.env.API_URL;
const pin = process.env.E2E_PIN;

if (!apiUrl || !pin) throw new Error('API_URL and E2E_PIN are required');

async function post(body) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${body.type} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const auth = await post({ type: 'verify_pin', pin });
if (!auth.token) throw new Error('verify_pin did not return a token');
const usage = await post({ type: 'get_usage', token: auth.token });
if (!Object.prototype.hasOwnProperty.call(usage, 'plan')) {
  throw new Error(`get_usage returned an unexpected payload: ${JSON.stringify(usage)}`);
}
console.log(`Deployed API smoke test passed (${usage.plan || 'unknown'} plan).`);
