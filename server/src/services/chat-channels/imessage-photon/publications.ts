import type { SafeChatPublicationPayload } from "@paperclipai/shared";

export function imessageProgressSupersessionReason(
  progress: SafeChatPublicationPayload["progressState"],
): string | null {
  return progress && ["queued", "working"].includes(progress)
    ? "iMessage uses typing instead of progress bubbles"
    : null;
}
