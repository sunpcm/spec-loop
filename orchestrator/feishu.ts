import type * as Lark from '@larksuiteoapi/node-sdk';

export interface FeishuSettings {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  chatId?: string;
  allowedUserIds: string[];
}

export interface FeishuCommands {
  status(): Promise<string>;
  retry(issueNumber: number): Promise<string>;
}

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

type FeishuCommand = { type: 'status' } | { type: 'retry'; issueNumber: number };

const DEDUP_LIMIT = 500;
const MAX_MESSAGE_LENGTH = 3500;
const HTTP_TIMEOUT_MS = 10_000;
const SAFE_LOG_MAX_LENGTH = 500;
const COMMAND_ACK_TEXT = '✅ 收到命令，正在处理，结果稍后返回。';
const COMMAND_ERROR_TEXT = '⚠️ 命令执行失败，请稍后重试。';

export function parseFeishuCommand(rawText: string): FeishuCommand | null {
  const text = rawText
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith('@'))
    .join(' ');
  if (text === '/status' || text === '状态') {
    return { type: 'status' };
  }
  const retryMatch = /^(?:\/retry\s+|重试\s*)#?([1-9][0-9]{0,9})$/.exec(text);
  if (retryMatch) {
    return { type: 'retry', issueNumber: Number(retryMatch[1]) };
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

  async function runCommand(command: FeishuCommand): Promise<string> {
    if (command.type === 'status') {
      return commands.status();
    }
    return commands.retry(command.issueNumber);
  }

  async function processCommand(chatId: string, command: FeishuCommand, messageId: string): Promise<void> {
    await enqueueSend(chatId, COMMAND_ACK_TEXT);
    try {
      const result = await runCommand(command);
      await enqueueSend(chatId, result);
      log(`飞书命令已完成: ${messageId}`);
    } catch (error) {
      await enqueueSend(chatId, COMMAND_ERROR_TEXT);
      log(`飞书命令执行失败: ${messageId} ${formatError(error)}`);
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
      const senderIds = extractSenderIds(event);
      const allowed = settings.allowedUserIds.some((allowedId) => senderIds.includes(allowedId));
      if (!allowed) {
        log(`拒绝未授权飞书消息: ${messageId}`);
        return;
      }
      const chatId = message.chat_id;
      if (!chatId || !settings.chatId || chatId !== settings.chatId) {
        log(`拒绝非配置会话的飞书消息: ${messageId}`);
        return;
      }
      const command = parseFeishuCommand(extractMessageText(message.content));
      if (!command) {
        log(`忽略无法识别的飞书命令: ${messageId}`);
        return;
      }
      void processCommand(chatId, command, messageId);
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
