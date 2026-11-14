export interface FeishuSettings {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  chatId?: string;
  allowedUserIds: string[];
}

export interface FeishuActorContext {
  messageId: string;
  actorId: string;
  chatId: string;
  senderType: 'user';
}

export interface FeishuCommands {
  status(): Promise<string>;
  retry(issueNumber: number): Promise<string>;
  help(): Promise<string>;
  require(description: string, messageId?: string): Promise<string>;
  retryRequirement(requestId: string): Promise<string>;
  merge(prNumber: number, context?: FeishuActorContext): Promise<string>;
  confirmMerge(prNumber: number, confirmationCode: string, context?: FeishuActorContext): Promise<string>;
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
