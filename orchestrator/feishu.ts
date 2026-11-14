import type * as Lark from '@larksuiteoapi/node-sdk';
import { HELP_TEXT } from './feishu-help.ts';
import {
  computeSpecRequestId,
  normalizeSpecDescription,
  SPEC_REQUEST_ID_RE,
} from './spec-identity.ts';

export interface FeishuSettings {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  chatId?: string;
  allowedUserIds: string[];
}

import type { FeishuActorContext, FeishuCommands } from './feishu-contract.ts';

export interface FeishuBridge {
  start(): Promise<void>;
  notify(text: string): Promise<void>;
  stop(): Promise<void>;
}

export type FeishuLogger = (message: string) => void;

export type FeishuIncomingEvent = Parameters<
  NonNullable<Lark.EventHandles['im.message.receive_v1']>
>[0];

export interface FeishuMessageClient {
  sendText(chatId: string, text: string): Promise<void>;
}

export interface FeishuEventDispatcher {
  register(handlers: {
    'im.message.receive_v1': (event: FeishuIncomingEvent) => void | Promise<void>;
  }): unknown;
}

export interface FeishuWebSocket {
  start(): Promise<void>;
  close(params?: { force?: boolean }): void;
}

export interface FeishuDependencies {
  createMessageClient(settings: FeishuSettings): Promise<FeishuMessageClient>;
  createEventDispatcher(): Promise<FeishuEventDispatcher>;
  createWebSocket(settings: FeishuSettings, eventDispatcher: FeishuEventDispatcher): Promise<FeishuWebSocket>;
}

type FeishuCommand =
  | { type: 'status' }
  | { type: 'retry'; issueNumber: number }
  | { type: 'require'; description: string }
  | { type: 'retry-requirement'; requestId: string }
  | { type: 'invalid-requirement'; message: string }
  | { type: 'merge'; prNumber: number }
  | { type: 'confirm-merge'; prNumber: number; confirmationCode: string }
  | { type: 'invalid-merge'; message: string }
  | { type: 'help' }
  | { type: 'unknown' };

const DEDUP_LIMIT = 500;
const MAX_MESSAGE_LENGTH = 3500;
const HTTP_TIMEOUT_MS = 10_000;
const SAFE_LOG_MAX_LENGTH = 500;
const COMMAND_ACK_TEXT = '✅ 收到命令，正在处理，结果稍后返回。';
const COMMAND_ERROR_TEXT = '⚠️ 命令执行失败，请稍后重试。';

export function parseFeishuCommand(rawText: string): FeishuCommand | null {
  // 只去掉开头与结尾空白和 @ 提及，内部换行保持原样，避免折叠需求描述。
  const text = rawText
    .trim()
    .replace(/^(?:@[^\s@]+\s*)+/, '')
    .trim();
  if (text === '/status' || text === '状态') {
    return { type: 'status' };
  }
  if (text === '/help' || text === '帮助') {
    return { type: 'help' };
  }
  const retryMatch = /^(?:\/retry\s+|重试\s*)#?([1-9][0-9]{0,9})$/.exec(text);
  if (retryMatch) {
    return { type: 'retry', issueNumber: Number(retryMatch[1]) };
  }
  const retryRequirementMatch = /^(?:\/retry-requirement\s+|重试需求\s+)([A-Za-z0-9]{6,64})$/.exec(text);
  if (retryRequirementMatch) {
    const requestId = retryRequirementMatch[1]!;
    if (SPEC_REQUEST_ID_RE.test(requestId)) {
      return { type: 'retry-requirement', requestId };
    }
  }
  if (text.startsWith('确认合并')) {
    const match = /^确认合并\s*#([1-9][0-9]{0,9})\s+([0-9A-Fa-f]{8})$/.exec(text);
    if (!match) {
      return {
        type: 'invalid-merge',
        message: '⚠️ 确认格式应为：确认合并 #N 8位十六进制确认码',
      };
    }
    return {
      type: 'confirm-merge',
      prNumber: Number(match[1]),
      confirmationCode: match[2]!.toLowerCase(),
    };
  }
  if (text.startsWith('/merge') || text.startsWith('合并')) {
    const match = /^(?:\/merge\s+#?([1-9][0-9]{0,9})|合并\s*PR\s*#([1-9][0-9]{0,9}))$/.exec(text);
    if (!match) {
      return {
        type: 'invalid-merge',
        message: '⚠️ 合并预检格式应为：合并 PR #N 或 /merge N',
      };
    }
    return { type: 'merge', prNumber: Number(match[1] ?? match[2]) };
  }
  const requireMatch = /^(?:\/require(?:\s+([\s\S]*))?|需求\s*[:：]\s*([\s\S]*))$/.exec(text);
  if (requireMatch) {
    const rawDescription = requireMatch[1] ?? requireMatch[2] ?? '';
    try {
      const description = normalizeSpecDescription(rawDescription);
      return { type: 'require', description };
    } catch (error) {
      return {
        type: 'invalid-requirement',
        message: `⚠️ ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return null;
}

function extractMessageText(content: string | undefined): string {
  if (!content) {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object' && 'text' in parsed) {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text === 'string') {
        return text;
      }
    }
  } catch {
    return content;
  }
  return content;
}

function extractSenderIds(event: FeishuIncomingEvent): string[] {
  const senderId = event.sender?.sender_id;
  return [senderId?.open_id, senderId?.user_id, senderId?.union_id].filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  );
}

function trustedActorContext(
  event: FeishuIncomingEvent,
  settings: FeishuSettings,
  messageId: string,
  chatId: string,
): FeishuActorContext | null {
  if (event.sender?.sender_type !== 'user') {
    return null;
  }
  const allowed = new Set(settings.allowedUserIds.map((id) => id.trim()).filter(Boolean));
  const actorId = extractSenderIds(event).find((id) => allowed.has(id.trim()));
  if (!actorId) {
    return null;
  }
  return {
    messageId,
    actorId: actorId.trim(),
    chatId,
    senderType: 'user',
  };
}

function truncateForFeishu(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_MESSAGE_LENGTH)}…(已截断)`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateLogText(text: string): string {
  return text.length > SAFE_LOG_MAX_LENGTH ? `${text.slice(0, SAFE_LOG_MAX_LENGTH)}…` : text;
}

function safeLogValue(value: unknown): string {
  if (typeof value === 'string') {
    return truncateLogText(value);
  }
  if (value instanceof Error) {
    return truncateLogText(`${value.name}: ${value.message}`);
  }
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return `[${typeof value}]`;
}

export function validateFeishuApiSuccess(response: unknown): void {
  if (response === null || typeof response !== 'object' || !('code' in response)) {
    throw new Error(`飞书API响应缺少业务状态码: ${safeLogValue(response)}`);
  }
  const code = (response as { code: unknown }).code;
  if (code !== 0) {
    const message = (response as { msg?: unknown }).msg;
    throw new Error(`飞书API业务失败 code=${safeLogValue(code)} msg=${safeLogValue(message)}`);
  }
}

export function createSafeSdkLogger(log: FeishuLogger): Lark.Logger {
  const write = (level: string, messages: unknown[]): void => {
    const summary = messages.map(safeLogValue).join(' ');
    log(`飞书SDK ${level}: ${truncateLogText(summary)}`);
  };
  return {
    error: (...messages: unknown[]) => write('error', messages),
    warn: (...messages: unknown[]) => write('warn', messages),
    info: (...messages: unknown[]) => write('info', messages),
    debug: (...messages: unknown[]) => write('debug', messages),
    trace: (...messages: unknown[]) => write('trace', messages),
  };
}

function requiredSetting(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`飞书配置缺少 ${name}`);
  }
  return trimmed;
}

function getMissingSettings(settings: FeishuSettings): string[] {
  const missing: string[] = [];
  if (!settings.appId?.trim()) missing.push('appId');
  if (!settings.appSecret?.trim()) missing.push('appSecret');
  if (!settings.chatId?.trim()) missing.push('chatId');
  return missing;
}

async function createRealDependencies(log: FeishuLogger): Promise<FeishuDependencies> {
  const lark = await import('@larksuiteoapi/node-sdk');
  const safeLogger = createSafeSdkLogger(log);
  const baseHttpInstance = lark.defaultHttpInstance as unknown as Lark.HttpInstance;
  const boundedHttpInstance: Lark.HttpInstance = {
    ...baseHttpInstance,
    request(options) {
      return baseHttpInstance.request({ ...options, timeout: HTTP_TIMEOUT_MS });
    },
  };
  return {
    async createMessageClient(settings) {
      const client = new lark.Client({
        appId: requiredSetting(settings.appId, 'appId'),
        appSecret: requiredSetting(settings.appSecret, 'appSecret'),
        domain: lark.Domain.Feishu,
        logger: safeLogger,
        httpInstance: boundedHttpInstance,
      });
      return {
        async sendText(chatId: string, text: string) {
          const response: unknown = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: truncateForFeishu(text) }),
            },
          });
          validateFeishuApiSuccess(response);
        },
      };
    },
    async createEventDispatcher() {
      return new lark.EventDispatcher({});
    },
    async createWebSocket(settings, eventDispatcher) {
      const socket = new lark.WSClient({
        appId: requiredSetting(settings.appId, 'appId'),
        appSecret: requiredSetting(settings.appSecret, 'appSecret'),
        domain: lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.info,
        logger: safeLogger,
        httpInstance: boundedHttpInstance,
        handshakeTimeoutMs: HTTP_TIMEOUT_MS,
      });
      return {
        start() {
          return socket.start({ eventDispatcher: eventDispatcher as Lark.EventDispatcher });
        },
        close(params?: { force?: boolean }) {
          socket.close(params);
        },
      };
    },
  };
}

export function createFeishuBridge(
  settings: FeishuSettings,
  commands: FeishuCommands,
  logger?: FeishuLogger,
): FeishuBridge {
  const log: FeishuLogger = logger ?? (() => {});
  return createFeishuBridgeWithDependencies(settings, commands, log, () => createRealDependencies(log));
}

export function createFeishuBridgeWithDependencies(
  settings: FeishuSettings,
  commands: FeishuCommands,
  logger: FeishuLogger = () => {},
  loadDependencies: () => Promise<FeishuDependencies>,
): FeishuBridge {
  const log = logger;
  let running = false;
  let startPromise: Promise<void> | null = null;
  let messageClient: FeishuMessageClient | null = null;
  let activeSocket: FeishuWebSocket | null = null;
  let sendQueue: Promise<void> = Promise.resolve();
  const seenMessageIds = new Set<string>();
  const seenMessageOrder: string[] = [];

  function rememberMessageId(messageId: string): boolean {
    if (seenMessageIds.has(messageId)) {
      return true;
    }
    seenMessageIds.add(messageId);
    seenMessageOrder.push(messageId);
    if (seenMessageOrder.length > DEDUP_LIMIT) {
      const expired = seenMessageOrder.shift();
      if (expired !== undefined) {
        seenMessageIds.delete(expired);
      }
    }
    return false;
  }

  function enqueueSend(chatId: string, text: string): Promise<void> {
    const client = messageClient;
    if (!client) {
      return Promise.resolve();
    }
    sendQueue = sendQueue.then(async () => {
      try {
        await client.sendText(chatId, truncateForFeishu(text));
      } catch (error) {
        log(`飞书消息发送失败: ${formatError(error)}`);
      }
    });
    return sendQueue;
  }

  async function runCommand(
    command: FeishuCommand,
    messageId: string,
    context: FeishuActorContext,
  ): Promise<string> {
    if (command.type === 'status') {
      return commands.status();
    }
    if (command.type === 'retry') {
      return commands.retry(command.issueNumber);
    }
    if (command.type === 'require') {
      return commands.require(command.description, messageId);
    }
    if (command.type === 'retry-requirement') {
      return commands.retryRequirement(command.requestId);
    }
    if (command.type === 'merge') {
      return commands.merge(command.prNumber, context);
    }
    if (command.type === 'confirm-merge') {
      return commands.confirmMerge(command.prNumber, command.confirmationCode, context);
    }
    if (command.type === 'invalid-requirement') {
      return command.message;
    }
    if (command.type === 'invalid-merge') {
      return command.message;
    }
    if (command.type === 'help') {
      return commands.help();
    }
    return HELP_TEXT;
  }

  async function processCommand(
    chatId: string,
    command: FeishuCommand,
    context: FeishuActorContext,
  ): Promise<void> {
    if (command.type !== 'invalid-requirement' && command.type !== 'invalid-merge') {
      const ackText =
        command.type === 'require'
          ? `✅ 已收到需求消息，候选请求ID：${computeSpecRequestId(context.messageId)}；检查通过后受理`
          : COMMAND_ACK_TEXT;
      await enqueueSend(chatId, ackText);
    }
    try {
      const result = await runCommand(command, context.messageId, context);
      await enqueueSend(chatId, result);
      log(`飞书命令已完成: ${context.messageId}`);
    } catch (error) {
      await enqueueSend(chatId, COMMAND_ERROR_TEXT);
      log(`飞书命令执行失败: ${context.messageId} ${formatError(error)}`);
    }
  }

  async function handleIncomingMessage(event: FeishuIncomingEvent): Promise<void> {
    try {
      if (!running) {
        return;
      }
      const message = event.message;
      const messageId = message?.message_id;
      if (typeof messageId !== 'string' || messageId.length === 0) {
        return;
      }
      if (rememberMessageId(messageId)) {
        log(`跳过重复飞书消息: ${messageId}`);
        return;
      }
      if (message?.message_type !== 'text') {
        return;
      }
      const chatId = message.chat_id;
      const context = chatId
        ? trustedActorContext(event, settings, messageId, chatId)
        : null;
      if (!context) {
        log(`拒绝未授权飞书消息: ${messageId}`);
        return;
      }
      if (!chatId || !settings.chatId || chatId !== settings.chatId) {
        log(`拒绝非配置会话的飞书消息: ${messageId}`);
        return;
      }
      const command = parseFeishuCommand(extractMessageText(message.content));
      if (!command) {
        log(`未识别消息，回复帮助: ${messageId}`);
        void processCommand(chatId, { type: 'unknown' }, context);
        return;
      }
      void processCommand(chatId, command, context);
    } catch (error) {
      log(`处理飞书消息异常: ${formatError(error)}`);
    }
  }

  async function closeSocketQuietly(socket: FeishuWebSocket | null): Promise<void> {
    if (!socket) {
      return;
    }
    try {
      socket.close();
    } catch (error) {
      log(`关闭飞书长连接失败: ${formatError(error)}`);
    }
  }

  async function startInternal(): Promise<void> {
    if (!settings.enabled) {
      log('飞书未启用，跳过启动');
      return;
    }
    const missing = getMissingSettings(settings);
    if (missing.length > 0) {
      throw new Error(`飞书已启用但缺少配置: ${missing.join('、')}`);
    }
    let socket: FeishuWebSocket | null = null;
    try {
      const dependencies = await loadDependencies();
      messageClient = await dependencies.createMessageClient(settings);
      const dispatcher = await dependencies.createEventDispatcher();
      dispatcher.register({ 'im.message.receive_v1': handleIncomingMessage });
      socket = await dependencies.createWebSocket(settings, dispatcher);
      seenMessageIds.clear();
      seenMessageOrder.length = 0;
      running = true;
      activeSocket = socket;
      await socket.start();
      log('飞书长连接已启动');
    } catch (error) {
      running = false;
      activeSocket = null;
      messageClient = null;
      await closeSocketQuietly(socket);
      throw error;
    }
  }

  return {
    start() {
      if (!startPromise) {
        startPromise = startInternal().catch((error: unknown) => {
          startPromise = null;
          throw error;
        });
      }
      return startPromise;
    },
    async notify(text: string) {
      if (!settings.enabled) {
        log('飞书未启用，跳过通知');
        return;
      }
      if (!running || !messageClient || !settings.chatId) {
        log('飞书桥未启动，跳过通知');
        return;
      }
      await enqueueSend(settings.chatId, text);
    },
    async stop() {
      const socket = activeSocket;
      running = false;
      startPromise = null;
      messageClient = null;
      activeSocket = null;
      seenMessageIds.clear();
      seenMessageOrder.length = 0;
      await closeSocketQuietly(socket);
      log('飞书桥已停止');
    },
  };
}
