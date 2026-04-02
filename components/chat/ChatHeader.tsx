'use client';

import { type Contact } from '../../utils/api';
import UserAvatar from '../UserAvatar';
import styles from '../../styles/chat.module.css';

interface ChatHeaderProps {
  contact: Contact;
  isMobileLayout: boolean;
  isActiveChatPinned: boolean;
  isActiveGroupChat: boolean;
  onBack: () => void;
  onToggleSearch: () => void;
  onShowProfile: () => void;
  onTogglePin: () => void;
  onStartDirectCall: (mode: 'audio' | 'video') => void;
  onStartGroupCall: (mode: 'audio' | 'video') => void;
}

function getAvatarLabel(contact: Contact) {
  return (contact.displayName || contact.username).slice(0, 2).toUpperCase();
}

function getPresenceText(contact: Contact | null) {
  if (!contact) {
    return '';
  }

  if (contact.type === 'group') {
    return `${contact.memberIds?.length || 0} участников`;
  }

  if (contact.online) {
    return contact.bio ? `В сети - ${contact.bio}` : 'В сети сейчас';
  }

  if (contact.lastSeenAt) {
    return `Был(а) в сети ${new Date(contact.lastSeenAt).toLocaleString([], {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }

  return contact.bio || contact.email;
}

export default function ChatHeader({
  contact,
  isMobileLayout,
  isActiveChatPinned,
  isActiveGroupChat,
  onBack,
  onToggleSearch,
  onShowProfile,
  onTogglePin,
  onStartDirectCall,
  onStartGroupCall,
}: ChatHeaderProps) {
  return (
    <div className={styles.panelHeader}>
      <div
        className={styles.panelIdentityButton}
        role="button"
        tabIndex={0}
        onClick={onShowProfile}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onShowProfile();
          }
        }}
      >
        <div className={styles.panelIdentity}>
          {isMobileLayout ? (
            <button
              type="button"
              className={styles.backButton}
              onClick={(event) => {
                event.stopPropagation();
                onBack();
              }}
            >
              ←
            </button>
          ) : null}
          <UserAvatar
            avatarUrl={contact.avatarUrl}
            alt={contact.displayName || contact.username}
            fallback={getAvatarLabel(contact)}
            className={`${styles.headerAvatar} ${styles[`avatar_${contact.avatarColor || 'ocean'}`]}`}
            imageClassName={styles.avatarImage}
          />
          <div>
            <div className={styles.panelEyebrow}>{contact.type === 'group' ? 'Группа' : 'Личный чат'}</div>
            <h2 className={styles.panelTitle}>{contact.type === 'group' ? contact.displayName || contact.username : `Чат с ${contact.displayName || contact.username}`}</h2>
            <p className={styles.panelText}>{getPresenceText(contact)}</p>
          </div>
        </div>
      </div>
      <div className={styles.headerActions}>
        <button
          type="button"
          className={styles.headerIconButton}
          onClick={onToggleSearch}
          aria-label="Поиск по диалогу"
          title="Поиск по диалогу"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}>
            <path
              d="M10.5 4a6.5 6.5 0 1 0 4.03 11.6l4.43 4.44 1.04-1.04-4.44-4.43A6.5 6.5 0 0 0 10.5 4Zm0 1.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          className={styles.headerIconButton}
          onClick={onShowProfile}
          aria-label="Медиа и информация"
          title="Медиа и информация"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}>
            <path
              d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 1.5a.5.5 0 0 0-.5.5v8.12l3.35-3.35a1 1 0 0 1 1.42 0l1.73 1.73 3.15-3.15a1 1 0 0 1 1.41 0l1.94 1.94V6a.5.5 0 0 0-.5-.5H6Zm12 13a.5.5 0 0 0 .5-.5v-3.44l-2.65-2.65-3.15 3.15a1 1 0 0 1-1.41 0l-1.73-1.73-3.06 3.06V18c0 .28.22.5.5.5h12ZM9 8.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          className={styles.headerIconButton}
          onClick={onTogglePin}
          aria-label={isActiveChatPinned ? 'Открепить чат' : 'Закрепить чат'}
          title={isActiveChatPinned ? 'Открепить чат' : 'Закрепить чат'}
        >
          {isActiveChatPinned ? '★' : '☆'}
        </button>
        {!isActiveGroupChat ? <button
          type="button"
          className={styles.headerIconButton}
          onClick={() => onStartDirectCall('audio')}
          aria-label="Аудиозвонок"
          title="Аудиозвонок"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}>
            <path
              d="M6.6 10.8c1.6 3.1 3.5 5 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.08.36 2.24.54 3.46.54a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.52 21 3 13.48 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.22.18 2.38.54 3.46a1 1 0 0 1-.24 1l-2.2 2.34Z"
              fill="currentColor"
            />
          </svg>
        </button> : null}
        {!isActiveGroupChat ? <button
          type="button"
          className={styles.headerVideoButton}
          onClick={() => onStartDirectCall('video')}
          aria-label="Видеозвонок"
          title="Видеозвонок"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}>
            <path
              d="M14 7a2 2 0 0 1 2 2v1.38l3.55-2.37A1 1 0 0 1 21 8.84v6.32a1 1 0 0 1-1.45.83L16 13.62V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h9Z"
              fill="currentColor"
            />
          </svg>
        </button> : null}
        {isActiveGroupChat ? <button type="button" className={styles.headerIconButton} onClick={() => onStartGroupCall('audio')} aria-label="Групповой аудиозвонок" title="Групповой аудиозвонок">
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M6.6 10.8c1.6 3.1 3.5 5 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.08.36 2.24.54 3.46.54a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.52 21 3 13.48 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.22.18 2.38.54 3.46a1 1 0 0 1-.24 1l-2.2 2.34Z" fill="currentColor"/></svg>
        </button> : null}
        {isActiveGroupChat ? <button type="button" className={styles.headerVideoButton} onClick={() => onStartGroupCall('video')} aria-label="Групповой видеозвонок" title="Групповой видеозвонок">
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M14 7a2 2 0 0 1 2 2v1.38l3.55-2.37A1 1 0 0 1 21 8.84v6.32a1 1 0 0 1-1.45.83L16 13.62V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h9Z" fill="currentColor"/></svg>
        </button> : null}
      </div>
    </div>
  );
}
