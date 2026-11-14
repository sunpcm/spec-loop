import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFeishuBridgeWithDependencies,
  createSafeSdkLogger,
  parseFeishuCommand,
  validateFeishuApiSuccess,
  type FeishuDependencies,
  type FeishuEventDispatcher,
  type FeishuIncomingEvent,
  type FeishuSettings,
} from '../orchestrator/feishu.ts';

function createSettings(overrides: Partial<FeishuSettings> = {}): FeishuSettings {
  return {
    enabled: true,
    appId: 'cli_fake_app_id',
    appSecret: 'fake_app_secret_fixture',
    chatId: 'oc_fake_chat',
    allowedUserIds: ['ou_allowed_user'],
    ...overrides,
  };
}

function createCommands(overrides: { statusError?: Error; retryError?: Error } = {}) {
  let statusCalls = 0;
  const retryCalls: number[] = [];
  return {
    commands: {
      async status(): Promise<string> {
        statusCalls += 1;
        if (overrides.statusError) {
          throw overrides.statusError;
        }
        return 'STATUS_OK';
      },
      async retry(issueNumber: number): Promise<string> {
        retryCalls.push(issueNumber);
        if (overrides.retryError) {
          throw overrides.retryError;
        }
        return `RETRY_OK_${issueNumber}`;
      },
    },
    get statusCalls() {
      return statusCalls;
    },
    get retryCalls() {
      return [...retryCalls];
    },
  };
}

function createFakeHarness(options: { sendFailures?: number } = {}) {
  const sent: string[] = [];
  const logs: string[] = [];
  let socketStarts = 0;
  let socketCloses = 0;
  let sendFailures = options.sendFailures ?? 0;
  const handlers: Record<string, (event: FeishuIncomingEvent) => void | Promise<void>> = {};
  const dependencies: FeishuDependencies = {
    async createMessageClient() {
      return {
        async sendText(_chatId: string, text: string) {
          if (sendFailures > 0) {
            sendFailures -= 1;
            throw new Error('模拟飞书发送失败');
          }
          sent.push(text);
        },
      };
    },
    async createEventDispatcher(): Promise<FeishuEventDispatcher> {
      return {
        register(registrations) {
          Object.assign(handlers, registrations);
        },
      };
    },
    async createWebSocket() {
      return {
        async start() {
          socketStarts += 1;
        },
        close() {
          socketCloses += 1;
        },
      };
    },
  };
  return {
    sent,
    logs,
    dependencies,
    get socketStarts() {
      return socketStarts;
    },
    get socketCloses() {
      return socketCloses;
    },
    dispatch(event: FeishuIncomingEvent): Promise<void> {
      const handler = handlers['im.message.receive_v1'];
      assert.ok(handler, '未注册 im.message.receive_v1 处理器');
      return Promise.resolve(handler(event));
    },
  };
}

function createEvent(
  overrides: Partial<NonNullable<FeishuIncomingEvent['message']>> = {},
  senderOpenId = 'ou_allowed_user',
  chatId = 'oc_fake_chat',
): FeishuIncomingEvent {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: senderOpenId } },
    message: {
      message_id: 'om_message_1',
      chat_id: chatId,
      message_type: 'text',
      content: JSON.stringify({ text: '/status' }),
      create_time: '1760572800000',
      chat_type: 'group',
      ...overrides,
    },
  };
}

function messageAt(messages: string[], index: number): string {
  return messages[index] ?? '';
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail('等待测试条件超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('命令解析支持中英文命令、@前缀并拒绝非法输入', () => {
  assert.deepEqual(parseFeishuCommand('/status'), { type: 'status' });
  assert.deepEqual(parseFeishuCommand('状态'), { type: 'status' });
  assert.deepEqual(parseFeishuCommand('  @bot 状态 '), { type: 'status' });
  assert.deepEqual(parseFeishuCommand('/retry 128'), { type: 'retry', issueNumber: 128 });
  assert.deepEqual(parseFeishuCommand('/retry #128'), { type: 'retry', issueNumber: 128 });
  assert.deepEqual(parseFeishuCommand('重试 #42'), { type: 'retry', issueNumber: 42 });
  assert.deepEqual(parseFeishuCommand('重试42'), { type: 'retry', issueNumber: 42 });
  assert.equal(parseFeishuCommand('/retry 0'), null);
  assert.equal(parseFeishuCommand('重试 abc'), null);
  assert.equal(parseFeishuCommand('hello'), null);
  assert.equal(parseFeishuCommand(''), null);
});

test('飞书API真实envelope校验：code=0成功，非零或缺失状态码抛安全摘要', () => {
  assert.doesNotThrow(() => validateFeishuApiSuccess({ code: 0, msg: 'success', data: { message_id: 'om_x' } }));
  assert.throws(
    () => validateFeishuApiSuccess({ code: 230002, msg: 'invalid chat id' }),
    /飞书API业务失败 code=230002 msg=invalid chat id/,
  );
  assert.throws(() => validateFeishuApiSuccess('ok'), /飞书API响应缺少业务状态码: ok/);
  assert.throws(() => validateFeishuApiSuccess(null), /飞书API响应缺少业务状态码: null/);
});

test('SDK受控logger只输出安全摘要且不序列化请求配置或凭据', () => {
  const logs: string[] = [];
  const sdkLogger = createSafeSdkLogger((message) => logs.push(message));
  const axiosLikeError = Object.assign(new Error('Request failed with status code 401'), {
    config: { headers: { Authorization: 'Bearer fake-secret-token' } },
  });
  sdkLogger.error(axiosLikeError, 'send failed');
  sdkLogger.debug({ config: { Authorization: 'Bearer fake-secret-token' } });
  sdkLogger.info(123, true, null);
  assert.match(logs[0], /飞书SDK error: Error: Request failed with status code 401 send failed/);
  assert.ok(!logs.some((entry) => entry.includes('fake-secret-token')));
  assert.ok(!logs.some((entry) => entry.includes('Authorization')));
  assert.match(logs[1], /飞书SDK debug: \[object\]/);
  assert.match(logs[2], /飞书SDK info: 123 true null/);
});

test('未启用时 start/notify/stop 全部空转且不加载 SDK', async () => {
  const harness = createFakeHarness();
  const { commands } = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings({ enabled: false }),
    commands,
    (message) => harness.logs.push(message),
    () => Promise.reject(new Error('不应加载 SDK')),
  );
  await bridge.start();
  await bridge.notify('部署完成');
  await bridge.stop();
  assert.equal(harness.socketStarts, 0);
  assert.equal(harness.socketCloses, 0);
  assert.deepEqual(harness.sent, []);
  assert.ok(harness.logs.includes('飞书未启用，跳过启动'));
});

test('启用但配置不完整时明确报缺项且不加载 SDK', async () => {
  const harness = createFakeHarness();
  const { commands } = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings({ appId: '', appSecret: '', chatId: '' }),
    commands,
    () => {},
    () => Promise.reject(new Error('不应加载 SDK')),
  );
  await assert.rejects(bridge.start(), /飞书已启用但缺少配置: appId、appSecret、chatId/);
  await bridge.notify('不应发送');
  assert.deepEqual(harness.sent, []);
});

test('真实 snake_case 载荷的状态命令先快速 ACK 再异步返回结果', async () => {
  const harness = createFakeHarness();
  const commandState = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings(),
    commandState.commands,
    (message) => harness.logs.push(message),
    async () => harness.dependencies,
  );
  await bridge.start();
  await bridge.start();
  assert.equal(harness.socketStarts, 1);
  await harness.dispatch(createEvent({ message_id: 'om_status_1' }));
  await waitFor(() => harness.sent.length >= 2);
  assert.match(messageAt(harness.sent, 0), /收到命令/);
  assert.equal(messageAt(harness.sent, 1), 'STATUS_OK');
  assert.equal(commandState.statusCalls, 1);
  await bridge.stop();
});

test('中文状态与重试命令都能执行并传递 Issue 编号', async () => {
  const harness = createFakeHarness();
  const commandState = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings(),
    commandState.commands,
    () => {},
    async () => harness.dependencies,
  );
  await bridge.start();
  await harness.dispatch(
    createEvent({ message_id: 'om_cn_status', content: JSON.stringify({ text: '@助手 状态' }) }),
  );
  await waitFor(() => commandState.statusCalls === 1);
  await harness.dispatch(
    createEvent({ message_id: 'om_cn_retry', content: JSON.stringify({ text: '重试 #42' }) }),
  );
  await waitFor(() => commandState.retryCalls.length === 1);
  await waitFor(() => harness.sent.includes('RETRY_OK_42'));
  assert.equal(commandState.statusCalls, 1);
  assert.deepEqual(commandState.retryCalls, [42]);
  assert.ok(harness.sent.includes('STATUS_OK'));
  await bridge.stop();
});

test('重复消息按 message_id 去重且命令只执行一次', async () => {
  const harness = createFakeHarness();
  const commandState = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings(),
    commandState.commands,
    (message) => harness.logs.push(message),
    async () => harness.dependencies,
  );
  await bridge.start();
  const event = createEvent({ message_id: 'om_duplicate' });
  await harness.dispatch(event);
  await harness.dispatch(event);
  await waitFor(() => harness.sent.length >= 2);
  assert.equal(commandState.statusCalls, 1);
  assert.equal(harness.sent.filter((text) => text === 'STATUS_OK').length, 1);
  await bridge.stop();
});

test('白名单外的发送者和空白名单都被拒绝', async () => {
  const harness = createFakeHarness();
  const commandState = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings({ allowedUserIds: [] }),
    commandState.commands,
    (message) => harness.logs.push(message),
    async () => harness.dependencies,
  );
  await bridge.start();
  await harness.dispatch(createEvent({ message_id: 'om_empty_allowlist' }));
  await harness.dispatch(createEvent({ message_id: 'om_other_sender' }, 'ou_other_user'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(commandState.statusCalls, 0);
  assert.deepEqual(harness.sent, []);
  assert.ok(harness.logs.some((message) => message.includes('拒绝未授权飞书消息')));
  await bridge.stop();
});

test('配置群之外的会话不能触发命令', async () => {
  const harness = createFakeHarness();
  const commandState = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings(),
    commandState.commands,
    (message) => harness.logs.push(message),
    async () => harness.dependencies,
  );
  await bridge.start();
  await harness.dispatch(createEvent({ message_id: 'om_other_chat' }, 'ou_allowed_user', 'oc_other_chat'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(commandState.statusCalls, 0);
  assert.deepEqual(harness.sent, []);
  assert.ok(harness.logs.some((message) => message.includes('拒绝非配置会话的飞书消息')));
  await bridge.stop();
});

test('非文本消息与无法识别命令不会触发执行', async () => {
  const harness = createFakeHarness();
  const commandState = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings(),
    commandState.commands,
    () => {},
    async () => harness.dependencies,
  );
  await bridge.start();
  await harness.dispatch(createEvent({ message_id: 'om_image', message_type: 'image' }));
  await harness.dispatch(createEvent({ message_id: 'om_unknown', content: JSON.stringify({ text: '随便聊聊' }) }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(commandState.statusCalls, 0);
  assert.deepEqual(harness.sent, []);
  await bridge.stop();
});

test('命令失败只回执错误且不影响后续核心通知', async () => {
  const harness = createFakeHarness();
  const commandState = createCommands({ statusError: new Error('状态查询失败') });
  const bridge = createFeishuBridgeWithDependencies(
    createSettings(),
    commandState.commands,
    (message) => harness.logs.push(message),
    async () => harness.dependencies,
  );
  await bridge.start();
  await assert.doesNotReject(harness.dispatch(createEvent({ message_id: 'om_failed_command' })));
  await waitFor(() => harness.sent.includes('⚠️ 命令执行失败，请稍后重试。'));
  await bridge.notify('GitHub PR #42 已创建');
  await waitFor(() => harness.sent.includes('GitHub PR #42 已创建'));
  await bridge.stop();
});

test('通知发送失败不抛入核心链路且后续通知可恢复', async () => {
  const harness = createFakeHarness({ sendFailures: 1 });
  const { commands } = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings(),
    commands,
    (message) => harness.logs.push(message),
    async () => harness.dependencies,
  );
  await bridge.start();
  await assert.doesNotReject(bridge.notify('第一次会失败'));
  await bridge.notify('第二次成功');
  await waitFor(() => harness.sent.includes('第二次成功'));
  assert.deepEqual(harness.sent, ['第二次成功']);
  assert.ok(harness.logs.some((message) => message.includes('飞书消息发送失败')));
  await bridge.stop();
});

test('stop 真实关闭长连接且停止后回调不再触发命令', async () => {
  const harness = createFakeHarness();
  const commandState = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings(),
    commandState.commands,
    () => {},
    async () => harness.dependencies,
  );
  await bridge.start();
  await bridge.stop();
  assert.equal(harness.socketCloses, 1);
  await harness.dispatch(createEvent({ message_id: 'om_after_stop' }));
  await bridge.notify('停止后不发送');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(commandState.statusCalls, 0);
  assert.deepEqual(harness.sent, []);
  await bridge.stop();
  assert.equal(harness.socketCloses, 1);
});

test('超长通知会被截断', async () => {
  const harness = createFakeHarness();
  const { commands } = createCommands();
  const bridge = createFeishuBridgeWithDependencies(
    createSettings(),
    commands,
    () => {},
    async () => harness.dependencies,
  );
  await bridge.start();
  await bridge.notify('x'.repeat(4000));
  await waitFor(() => harness.sent.length === 1);
  assert.ok(messageAt(harness.sent, 0).length <= 3510);
  assert.ok(messageAt(harness.sent, 0).endsWith('…(已截断)'));
  await bridge.stop();
});
