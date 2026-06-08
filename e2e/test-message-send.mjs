import { startServer } from '../e2e/helpers/server.js';

const server = await startServer();

try {
  // Create conversation
  const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'test-msg' }),
  });
  const conv = await createRes.json();
  console.log(`Created conversation: test-msg, wsUrl: ${conv.wsUrl}`);

  // Start it (returns before session is ready)
  const startRes = await fetch(`${server.baseUrl}/api/conversations/test-msg/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const startBody = await startRes.json();
  console.log(`Start response: status=${startBody.status}, ready=${startBody.ready}, sessionId=${startBody.sessionId}, port=${startBody.port}`);

  // Poll for ready
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`${server.baseUrl}/api/conversations/test-msg`);
    const body = await res.json();
    if (body.ready === true && body.sessionId) {
      ready = true;
      console.log(`Ready after ${(i + 1) * 1000}ms, sessionId: ${body.sessionId}`);
      break;
    }
  }
  if (!ready) {
    console.error('Timed out waiting for ready state');
    process.exit(1);
  }

  // Try sending message with explicit agent 'build' (OpenCode built-in agent)
  const msgRes = await fetch(`${server.baseUrl}/api/conversations/test-msg/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello', agent: 'build' }),
  });
  const msgBody = await msgRes.text();
  console.log(`Message (agent=build): ${msgRes.status}`, msgBody.substring(0, 500));

} finally {
  await server.cleanup();
}
