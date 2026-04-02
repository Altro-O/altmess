'use client';

import { type Contact } from '../../utils/api';
import UserAvatar from '../UserAvatar';
import styles from '../../styles/chat.module.css';

interface ChatSidebarProps {
  sidebarItems: Contact[];
  activeContactId: string | null;
  searchQuery: string;
  pinnedChatIds: string[];
  showMobileChat: boolean;
  dialogScope: 'all' | 'direct' | 'group';
  onSearchChange: (query: string) => void;
  onOpenCreateGroup: () => void;
  onScopeChange: (scope: 'all' | 'direct' | 'group') => void;
  onSelectContact: (contactId: string) => void;
  onTogglePin: (contactId: string) => void;
}

function getAvatarLabel(contact: Contact) {
  return (contact.displayName || contact.username).slice(0, 2).toUpperCase();
}

function getMessagePreview(message?: Contact['lastMessage']) {
  if (!message) {
    return 'Начните диалог';
  }

  if (message.kind === 'call') {
    return message.content;
  }

  if (message.kind === 'voice') {
    return 'Голосовое сообщение';
  }

  if (message.kind === 'file') {
    if (message.attachment?.isSticker) {
      return 'Стикер';
    }

    return message.attachment?.mimeType?.startsWith('image/') ? 'Фото' : `Файл: ${message.attachment?.fileName || message.content}`;
  }

  return message.content.length > 42 ? `${message.content.slice(0, 42)}...` : message.content;
}

export default function ChatSidebar({
  sidebarItems,
  activeContactId,
  searchQuery,
  pinnedChatIds,
  showMobileChat,
  dialogScope,
  onSearchChange,
  onOpenCreateGroup,
  onScopeChange,
  onSelectContact,
  onTogglePin,
}: ChatSidebarProps) {
  return (
    <aside className={`${styles.sidebar} ${showMobileChat ? styles.sidebarHiddenMobile : ''}`}>
      <div className={styles.sidebarHeader}>
        <div>
          <h1 className={styles.sidebarTitle}>Диалоги</h1>
          <p className={styles.sidebarText}>Личные чаты, группы и быстрый доступ к недавним разговорам.</p>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={onOpenCreateGroup}>Новая группа</button>
      </div>

      <div className={styles.sidebarSegments}>
        <button type="button" className={`${styles.sidebarSegment} ${dialogScope === 'all' ? styles.sidebarSegmentActive : ''}`} onClick={() => onScopeChange('all')}>Все</button>
        <button type="button" className={`${styles.sidebarSegment} ${dialogScope === 'direct' ? styles.sidebarSegmentActive : ''}`} onClick={() => onScopeChange('direct')}>Личные</button>
        <button type="button" className={`${styles.sidebarSegment} ${dialogScope === 'group' ? styles.sidebarSegmentActive : ''}`} onClick={() => onScopeChange('group')}>Группы</button>
      </div>

      <input
        type="text"
        value={searchQuery}
        onChange={(event) => onSearchChange(event.target.value)}
        className={styles.searchInput}
        placeholder="Поиск по логину или email"
      />

      <div className={styles.contactList}>
        {sidebarItems.map((contact) => (
          <button
            key={contact.id}
            type="button"
            className={`${styles.contact} ${activeContactId === contact.id ? styles.contactActive : ''}`}
            onClick={() => onSelectContact(contact.id)}
          >
            <UserAvatar
              avatarUrl={contact.avatarUrl}
              alt={contact.displayName || contact.username}
              fallback={getAvatarLabel(contact)}
              className={`${styles.avatar} ${styles[`avatar_${contact.avatarColor || 'ocean'}`]}`}
              imageClassName={styles.avatarImage}
            />
            <span className={styles.contactMeta}>
              <span className={styles.contactNameRow}>
                <span className={styles.contactNameWrap}>
                  {pinnedChatIds.includes(contact.id) ? <span className={styles.pinnedMark}>Закреплен</span> : null}
                  <span className={styles.contactName}>{contact.displayName || contact.username}</span>
                </span>
                {contact.unreadCount ? <span className={styles.unreadBadge}>{contact.unreadCount}</span> : null}
              </span>
              <span className={styles.contactPreview}>
                {contact.lastMessage ? getMessagePreview(contact.lastMessage) : (contact.bio || contact.email)}
              </span>
            </span>
            <span
              role="button"
              tabIndex={0}
              className={styles.pinToggle}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(contact.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  onTogglePin(contact.id);
                }
              }}
            >
              {pinnedChatIds.includes(contact.id) ? '★' : '☆'}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
