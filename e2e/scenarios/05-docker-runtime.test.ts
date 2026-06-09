import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { startServer, type E2EServer } from '../helpers/server.js';
import { dockerOrchestratorConfig, TEST_DOCKER_IMAGE, TEST_CONTAINER_PORT } from '../../src/test-fixtures/ao-configs.js';
import { opencodeConfigWithProvider } from '../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../src/test-fixtures/helpers.js';

function isDockerAvailable(): boolean {
  const info = spawnSync('docker', ['info'], {
    stdio: 'ignore',
    timeout: 5000,
  });
  if (info.status !== 0) return false;

  const result = spawnSync('docker', ['inspect', TEST_DOCKER_IMAGE], {
    stdio: 'ignore',
    timeout: 5000,
  });
  return result.status === 0;
}

describe('Docker Runtime (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer({
      runtime: 'docker',
      docker: { image: TEST_DOCKER_IMAGE, containerPort: TEST_CONTAINER_PORT },
    });
  }, 30_000);

  afterAll(async () => {
    await server.cleanup();
  }, 15_000);

  it('starts with docker runtime config', () => {
    expect(server.orchestratorConfig.runtime).toBe('docker');
    expect(server.orchestratorConfig.docker).toBeDefined();
    expect(server.orchestratorConfig.docker!.image).toBe(TEST_DOCKER_IMAGE);
    expect(server.orchestratorConfig.docker!.containerPort).toBe(TEST_CONTAINER_PORT);
  });

  it('creates a conversation (prepared)', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-docker' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('e2e-docker');
    expect(body.status).toBe('prepared');
    expect(body.wsUrl).toContain('/ws/e2e-docker');
  });

  it('lists and gets conversation details', async () => {
    const listRes = await fetch(`${server.baseUrl}/api/conversations`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.some((c: any) => c.id === 'e2e-docker')).toBe(true);

    const getRes = await fetch(`${server.baseUrl}/api/conversations/e2e-docker`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.status).toBe('prepared');
    expect(body.ready).toBe(false);
  });

  it('rejects duplicate conversation', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-docker' }),
    });
    expect(res.status).toBe(409);
  });

  it('deletes conversation', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-docker`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });

  it('creates file and agent in docker runtime mode', async () => {
    await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-docker-files' }),
    });

    const fileRes = await fetch(`${server.baseUrl}/api/conversations/e2e-docker-files/files`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test/hello.txt', content: 'Hello from docker' }),
    });
    expect(fileRes.status).toBe(204);

    const agentRes = await fetch(`${server.baseUrl}/api/conversations/e2e-docker-files/agents`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'docker-tester', content: '---\nname: DockerTester\n---\nYou are a docker tester.' }),
    });
    expect(agentRes.status).toBe(204);
  });

  it('reads file and agent from workspace', async () => {
    const fileRes = await fetch(`${server.baseUrl}/api/conversations/e2e-docker-files/files/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test/hello.txt' }),
    });
    expect(fileRes.status).toBe(200);
    const fileBody = await fileRes.json();
    expect(fileBody.content).toBe('Hello from docker');

    const agentRes = await fetch(`${server.baseUrl}/api/conversations/e2e-docker-files/agents/docker-tester`);
    expect(agentRes.status).toBe(200);
    const agentBody = await agentRes.json();
    expect(agentBody.content).toContain('DockerTester');
  });

  describe('Docker instance lifecycle', () => {
    const dockerAvailable = isDockerAvailable();

    beforeAll(async () => {
      const res = await fetch(`${server.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'e2e-docker-lifecycle' }),
      });
      if (res.status !== 201) {
        const body = await res.json();
        throw new Error(`Failed to create lifecycle conversation: ${res.status} ${JSON.stringify(body)}`);
      }

      // Upload a test provider config so the started instance has model access
      await uploadOpencodeConfig(server.baseUrl, 'e2e-docker-lifecycle', opencodeConfigWithProvider);
    });

    afterAll(async () => {
      await fetch(`${server.baseUrl}/api/conversations/e2e-docker-lifecycle`, {
        method: 'DELETE',
      });
    });

    it('attempts to start conversation via Docker', async () => {
      const res = await fetch(`${server.baseUrl}/api/conversations/e2e-docker-lifecycle/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      if (dockerAvailable) {
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('running');
        expect(typeof body.port).toBe('number');
      } else {
        expect(res.status).toBe(500);
      }
    }, dockerAvailable ? 60_000 : 10_000);

    it('stops and restarts Docker conversation', async () => {
      if (!dockerAvailable) return;

      const stopRes = await fetch(`${server.baseUrl}/api/conversations/e2e-docker-lifecycle/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(stopRes.status).toBe(200);
      expect((await stopRes.json()).status).toBe('stopped');

      const restartRes = await fetch(`${server.baseUrl}/api/conversations/e2e-docker-lifecycle/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(restartRes.status).toBe(200);
      expect((await restartRes.json()).status).toBe('running');
    }, 60_000);
  });
});
