import type {
  CreateFeishuBridge,
  FeishuBridge,
  FeishuCommands,
  FeishuLogger,
  FeishuSettings,
} from './feishu-contract.ts';

interface FeishuModule {
  createFeishuBridge: CreateFeishuBridge;
}

export async function createFeishuBridgeRuntime(
  settings: FeishuSettings,
  commands: FeishuCommands,
  logger?: FeishuLogger,
): Promise<FeishuBridge | null> {
  if (!settings.enabled) return null;
  try {
    const specifier: string = './feishu.ts';
    const mod = (await import(specifier)) as FeishuModule;
    return await mod.createFeishuBridge(settings, commands, logger);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // 显式降级：不抛出、不静默，把加载失败原因透传给调用方日志，便于排查。
    logger?.(`飞书桥加载失败，降级为仅本地控制接口: ${reason}`);
    return null;
  }
}
