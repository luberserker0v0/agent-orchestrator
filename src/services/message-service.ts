import { InstanceManager, type InstanceInfo } from '../orchestrator/instance-manager.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { parseModelString } from '../utils/model-parser.js';
import { messagesSentTotal, messageSendDurationSeconds } from '../metrics/registry.js';

export interface SendResult {
  messageId: string;
  text: string;
  parts: unknown[];
}

export class MessageService {
  constructor(
    private instanceManager: InstanceManager,
    private conversationState: ConversationState
  ) {}

  private ensureReady(id: string): InstanceInfo {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }
    if (state.status !== 'running') {
      throw new AppError(409, ErrorCodes.CONVERSATION_NOT_RUNNING, `Conversation is not running (status: ${state.status})`);
    }
    if (!state.ready) {
      throw new AppError(409, ErrorCodes.INSTANCE_NOT_READY, 'Instance is not ready yet. OpenCode is still initializing.');
    }

    const instance = this.instanceManager.getInstance(id);
    if (!instance) {
      throw new AppError(500, ErrorCodes.INSTANCE_REFERENCE_LOST, 'Instance reference lost');
    }
    return instance;
  }

  async send(id: string, text: string, rawModel?: string, rawAgent?: string): Promise<SendResult> {
    const instance = this.ensureReady(id);

    if (!instance.sessionId) {
      throw new AppError(503, ErrorCodes.SESSION_NOT_READY, 'Session not ready yet');
    }

    const model = parseModelString(rawModel);
    const agent = typeof rawAgent === 'string' ? rawAgent : undefined;

    const start = performance.now();
    try {
      const response = await instance.client.sendPrompt(instance.sessionId, {
        model,
        agent,
        parts: [{ type: 'text' as const, text }],
      });

      const texts = (response.parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');

      this.conversationState.emitEvent(id, 'conversation.message', {
        messageId: response.info.id,
        text: texts,
        parts: response.parts,
        role: 'assistant',
      });

      messagesSentTotal.labels('success').inc();
      messageSendDurationSeconds.observe((performance.now() - start) / 1000);
      return { messageId: response.info.id, text: texts, parts: response.parts };
    } catch (err) {
      messagesSentTotal.labels('error').inc();
      messageSendDurationSeconds.observe((performance.now() - start) / 1000);
      throw err;
    }
  }

  async getHistory(id: string, sessionId?: string, limit?: number): Promise<unknown[]> {
    const instance = this.ensureReady(id);
    const sid = sessionId || instance.sessionId;
    if (!sid) {
      throw new AppError(503, ErrorCodes.SESSION_NOT_READY, 'Session not ready yet');
    }
    return instance.client.listMessages(sid, limit);
  }
}
