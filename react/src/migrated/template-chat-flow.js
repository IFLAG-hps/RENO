import flow from './template-chat-flow.json';

export const TEMPLATE_ROOM_PARTS = flow.roomParts;
export const TEMPLATE_STYLES = flow.styles;

function format(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

function withSuggestions(reply, suggestions) {
  return `${reply}\n[SUGGESTIONS: ${suggestions.join(', ')}]`;
}

export function getTemplateConversationContext(messages) {
  const userMessages = messages
    .filter(message => message?.role === 'user' && typeof message.content === 'string')
    .map(message => message.content.trim());
  const roomIndex = userMessages.findLastIndex(message => TEMPLATE_ROOM_PARTS[message]);
  const room = roomIndex >= 0 ? userMessages[roomIndex] : null;
  const part = room
    ? userMessages.slice(roomIndex + 1).findLast(message => TEMPLATE_ROOM_PARTS[room].includes(message)) || null
    : null;
  return { userMessages, room, part };
}

export function getTemplateAgentResponse(messages) {
  const { userMessages, room, part } = getTemplateConversationContext(messages);
  const latest = userMessages.at(-1);
  const lastAssistant = [...messages].reverse().find(message => message?.role === 'assistant' && typeof message.content === 'string')?.content || '';
  const offeredSuggestions = lastAssistant.match(/\[SUGGESTIONS:\s*(.+?)\]/)?.[1]
    ?.split(',').map(value => value.trim()) || [];

  if (TEMPLATE_ROOM_PARTS[latest] && (userMessages.length === 1 || offeredSuggestions.includes(latest))) {
    return withSuggestions(format(flow.messages.room, { room: latest }), TEMPLATE_ROOM_PARTS[latest]);
  }
  if (room && TEMPLATE_ROOM_PARTS[room].includes(latest) && offeredSuggestions.includes(latest)) {
    return withSuggestions(format(flow.messages.part, { room, part: latest }), TEMPLATE_STYLES);
  }
  if (room && part && TEMPLATE_STYLES.includes(latest) && offeredSuggestions.includes(latest)) {
    return withSuggestions(format(flow.messages.style, { room, part, style: latest }), ['写真をアップロード', '素材を探す', '概算を見る']);
  }
  return null;
}

export function getTemplateActionResponse(action, messages) {
  const { room, part } = getTemplateConversationContext(messages);
  if (action === 'choose-room') {
    return { reply: flow.messages.chooseRoom, suggestions: Object.keys(TEMPLATE_ROOM_PARTS) };
  }
  if (action === 'choose-part') {
    return room
      ? { reply: format(flow.messages.choosePart, { room }), suggestions: TEMPLATE_ROOM_PARTS[room] }
      : { reply: flow.messages.chooseRoom, suggestions: Object.keys(TEMPLATE_ROOM_PARTS) };
  }
  if (action === 'change-style') {
    if (room && part) return { reply: format(flow.messages.changeStyle, { room, part }), suggestions: TEMPLATE_STYLES };
    if (room) return { reply: format(flow.messages.choosePartForStyle, { room }), suggestions: TEMPLATE_ROOM_PARTS[room] };
    return { reply: flow.messages.chooseRoom, suggestions: Object.keys(TEMPLATE_ROOM_PARTS) };
  }
  return null;
}
