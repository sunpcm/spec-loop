import type { FeishuBridge } from './feishu-contract.ts';
import type { Logger } from './log.ts';

export class Notifier {
  private readonly bridge: FeishuBridge | null;
  private readonly logger: Logger;

  constructor(bridge: FeishuBridge | null, logger: Logger) {
    this.bridge = bridge;
    this.logger = logger;
  }

  async notify(text: string): Promise<void> {
    if (!this.bridge) return;
    try {
      await this.bridge.notify(text);
    } catch (error) {
      this.logger.warn(`飞书通知失败（不打断主链路）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
