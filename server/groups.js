const { randomUUID } = require('crypto');

function ensureGroupsState(db) {
  if (!Array.isArray(db.groups)) {
    db.groups = [];
  }

  return db;
}

function toGroupContactId(groupId) {
  return `group:${groupId}`;
}

function isGroupContactId(value) {
  return String(value || '').startsWith('group:');
}

function getGroupIdFromContactId(value) {
  return isGroupContactId(value) ? String(value).slice('group:'.length) : '';
}

function getGroupByContactId(db, contactId) {
  const groupId = getGroupIdFromContactId(contactId);
  return db.groups.find((group) => group.id === groupId) || null;
}

function isGroupMember(group, userId) {
  return Array.isArray(group?.memberIds) && group.memberIds.includes(userId);
}

function isGroupOwner(group, userId) {
  return Boolean(group && group.ownerId === userId);
}

function getGroupMessages(db, groupId) {
  return db.messages
    .filter((message) => message.groupId === groupId)
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt));
}

function buildGroupContact(db, group, currentUserId, sanitizeMessage) {
  const messages = getGroupMessages(db, group.id);
  const lastMessage = messages.at(-1) || null;

  return {
    id: toGroupContactId(group.id),
    type: 'group',
    username: group.title,
    displayName: group.title,
    email: '',
    bio: `${group.memberIds.length} участников`,
    avatarUrl: group.avatarUrl || '',
    avatarColor: group.avatarColor || 'berry',
    createdAt: group.createdAt,
    online: false,
    unreadCount: 0,
    ownerId: group.ownerId,
    memberIds: group.memberIds,
    lastMessage: lastMessage ? sanitizeMessage(lastMessage) : null,
    lastSeenAt: null,
  };
}

function buildGroupDialogs(db, currentUserId, sanitizeMessage) {
  return db.groups
    .filter((group) => isGroupMember(group, currentUserId))
    .map((group) => buildGroupContact(db, group, currentUserId, sanitizeMessage))
    .sort((first, second) => {
      const firstTime = first.lastMessage?.createdAt || first.createdAt || '';
      const secondTime = second.lastMessage?.createdAt || second.createdAt || '';
      return secondTime.localeCompare(firstTime);
    });
}

function getGroupPage(db, group, options, sanitizeMessage) {
  const limit = Math.min(Math.max(Number(options?.limit) || 40, 1), 100);
  const beforeMessageId = options?.beforeMessageId ? String(options.beforeMessageId) : '';
  const messages = getGroupMessages(db, group.id);

  let endIndex = messages.length;
  if (beforeMessageId) {
    const beforeIndex = messages.findIndex((message) => message.id === beforeMessageId);
    endIndex = beforeIndex >= 0 ? beforeIndex : messages.length;
  }

  const startIndex = Math.max(0, endIndex - limit);
  const pageMessages = messages.slice(startIndex, endIndex).map(sanitizeMessage);
  const pinnedMessages = messages
    .filter((message) => message.pinnedAt)
    .sort((first, second) => String(second.pinnedAt).localeCompare(String(first.pinnedAt)))
    .slice(0, 10)
    .map(sanitizeMessage);

  return {
    messages: pageMessages,
    pinnedMessages,
    hasMore: startIndex > 0,
    nextCursor: startIndex > 0 && pageMessages[0] ? pageMessages[0].id : null,
  };
}

function createGroupRecord({ ownerId, title, memberIds }) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: String(title || '').trim(),
    ownerId,
    memberIds: Array.from(new Set([ownerId, ...memberIds.map(String)])),
    createdAt: now,
    avatarUrl: '',
    avatarColor: 'berry',
  };
}

function buildGroupMembers(db, group, publicUser) {
  return group.memberIds
    .map((memberId) => db.users.find((user) => user.id === memberId))
    .filter(Boolean)
    .map((user) => ({
      ...publicUser(user),
      type: 'direct',
      ownerId: group.ownerId,
      memberIds: group.memberIds,
      online: false,
      unreadCount: 0,
      lastMessage: null,
    }));
}

function buildAvailableGroupContacts(db, group, currentUserId, publicUser) {
  const excluded = new Set(group.memberIds);
  excluded.add(currentUserId);

  return db.users
    .filter((user) => !excluded.has(user.id))
    .map((user) => ({
      ...publicUser(user),
      type: 'direct',
      online: false,
      unreadCount: 0,
      lastMessage: null,
    }));
}

function normalizePinnedTargetIds(input, currentUserId, db) {
  const validUserIds = new Set(db.users.map((user) => String(user.id)));
  const validGroupIds = new Set(db.groups.map((group) => toGroupContactId(group.id)));

  return Array.from(new Set(
    (Array.isArray(input) ? input : [])
      .map((value) => String(value || '').trim())
      .filter((value) => value && value !== currentUserId && (validUserIds.has(value) || validGroupIds.has(value))),
  ));
}

module.exports = {
  ensureGroupsState,
  toGroupContactId,
  isGroupContactId,
  getGroupByContactId,
  isGroupMember,
  isGroupOwner,
  buildGroupContact,
  buildGroupMembers,
  buildAvailableGroupContacts,
  buildGroupDialogs,
  getGroupPage,
  createGroupRecord,
  normalizePinnedTargetIds,
};
