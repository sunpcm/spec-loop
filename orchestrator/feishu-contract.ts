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
  help(): Promise<string>;
  require(description: string, messageId?: string): Promise<string>;
  retryRequirement(requestId: string): Promise<string>;
}

export type FeishuLogger = (message: string) => void;

export interface FeishuBridge {
  start(): Promise<void>;
  notify(text: string): Promise<void>;
  stop(): Promise<void>;
}

export type CreateFeishuBridge = (
  settings: FeishuSettings,
  commands: FeishuCommands,
  logger?: FeishuLogger,
) => Promise<FeishuBridge>;
