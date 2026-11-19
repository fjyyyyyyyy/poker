// Shared limits for the room service and the chat composer.
export const CHAT_MAX_LENGTH = 200;
export const CHAT_HISTORY_LIMIT = 100;
export const CHAT_COOLDOWN_MS = 1000;

export function cleanChatText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
}
