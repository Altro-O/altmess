'use client';

import UserAvatar from '../UserAvatar';
import type { ChatMessage, Contact } from '../../utils/api';
import styles from '../../styles/chat.module.css';

interface DialogProfileSheetProps {
  activeContact: Contact;
  isActiveChatPinned: boolean;
  isActiveGroupOwner: boolean;
  showDialogProfile: boolean;
  groupMembers: Contact[];
  isLoadingGroupDetails: boolean;
  filteredGroupAvailableContacts: Contact[];
  groupAddSearchQuery: string;
  isUpdatingGroupMembers: boolean;
  galleryImages: ChatMessage[];
  groupedGalleryImages: Array<{ key: string; label: string; items: ChatMessage[] }>;
  getAvatarLabel: (contact: Contact) => string;
  getPresenceText: (contact: Contact | null) => string;
  onClose: () => void;
  onTogglePinnedChat: () => void;
  onOpenMessageSearch: () => void;
  onLeaveGroup: () => void;
  onDeleteGroup: () => void;
  onUpdateGroupAddSearchQuery: (value: string) => void;
  onUpdateGroupMembers: (payload: { addMemberIds?: string[]; removeMemberIds?: string[] }) => void;
  onPreviewImage: (payload: { src: string; name: string }) => void;
  onJumpToMessage: (messageId: string) => void;
}

export default function DialogProfileSheet(props: DialogProfileSheetProps) {
  const {
    activeContact,
    isActiveChatPinned,
    isActiveGroupOwner,
    showDialogProfile,
    groupMembers,
    isLoadingGroupDetails,
    filteredGroupAvailableContacts,
    groupAddSearchQuery,
    isUpdatingGroupMembers,
    galleryImages,
    groupedGalleryImages,
    getAvatarLabel,
    getPresenceText,
    onClose,
    onTogglePinnedChat,
    onOpenMessageSearch,
    onLeaveGroup,
    onDeleteGroup,
    onUpdateGroupAddSearchQuery,
    onUpdateGroupMembers,
    onPreviewImage,
    onJumpToMessage,
  } = props;

  if (!showDialogProfile) {
    return null;
  }

  return (
    <div className={styles.dialogProfileBackdrop} onClick={onClose}>
      <div className={styles.dialogProfileSheet} onClick={(event) => event.stopPropagation()}>
        <div className={styles.dialogProfileHeader}>
          <UserAvatar
            avatarUrl={activeContact.avatarUrl}
            alt={activeContact.displayName || activeContact.username}
            fallback={getAvatarLabel(activeContact)}
            className={`${styles.dialogProfileAvatar} ${styles[`avatar_${activeContact.avatarColor || 'ocean'}`]}`}
            imageClassName={styles.avatarImage}
          />
          <div>
            <h3 className={styles.dialogProfileTitle}>{activeContact.displayName || activeContact.username}</h3>
            <p className={styles.dialogProfileText}>{getPresenceText(activeContact)}</p>
          </div>
        </div>
        <div className={styles.dialogProfileActions}>
          <button type="button" className={styles.secondaryButton} onClick={onTogglePinnedChat}>{isActiveChatPinned ? 'Открепить чат' : 'Закрепить чат'}</button>
          <button type="button" className={styles.secondaryButton} onClick={onOpenMessageSearch}>Поиск в диалоге</button>
          {activeContact.type === 'group' && !isActiveGroupOwner ? <button type="button" className={styles.secondaryButton} onClick={onLeaveGroup}>Выйти из группы</button> : null}
          {activeContact.type === 'group' && isActiveGroupOwner ? <button type="button" className={styles.secondaryButton} onClick={onDeleteGroup}>Удалить группу</button> : null}
        </div>
        {activeContact.type === 'group' ? (
          <>
            <div className={styles.galleryHeaderRow}>
              <strong>Участники</strong>
              <span>{groupMembers.length || activeContact.memberIds?.length || 0}</span>
            </div>
            {isLoadingGroupDetails ? <p className={styles.galleryEmpty}>Загружаем участников...</p> : null}
            {groupMembers.length ? (
              <div className={styles.groupMemberList}>
                {groupMembers.map((member) => (
                  <div key={member.id} className={styles.groupMemberCard}>
                    <div className={styles.groupMemberIdentity}>
                      <UserAvatar
                        avatarUrl={member.avatarUrl}
                        alt={member.displayName || member.username}
                        fallback={getAvatarLabel(member)}
                        className={`${styles.avatar} ${styles[`avatar_${member.avatarColor || 'ocean'}`]}`}
                        imageClassName={styles.avatarImage}
                      />
                      <div>
                        <div className={styles.contactName}>{member.displayName || member.username}</div>
                        <div className={styles.contactPreview}>{member.id === activeContact.ownerId ? 'Владелец группы' : (member.bio || member.email || member.username)}</div>
                      </div>
                    </div>
                    {isActiveGroupOwner && member.id !== activeContact.ownerId ? (
                      <button type="button" className={styles.smallMutedButton} onClick={() => onUpdateGroupMembers({ removeMemberIds: [member.id] })} disabled={isUpdatingGroupMembers}>
                        Удалить
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {isActiveGroupOwner ? (
              <>
                <div className={styles.galleryHeaderRow}>
                  <strong>Добавить участников</strong>
                  <span>{filteredGroupAvailableContacts.length}</span>
                </div>
                <input
                  type="text"
                  value={groupAddSearchQuery}
                  onChange={(event) => onUpdateGroupAddSearchQuery(event.target.value)}
                  className={styles.dialogSearchInput}
                  placeholder="Поиск по активным диалогам"
                />
                {filteredGroupAvailableContacts.length ? (
                  <div className={styles.groupMemberList}>
                    {filteredGroupAvailableContacts.map((member) => (
                      <div key={member.id} className={styles.groupMemberCard}>
                        <div className={styles.groupMemberIdentity}>
                          <UserAvatar
                            avatarUrl={member.avatarUrl}
                            alt={member.displayName || member.username}
                            fallback={getAvatarLabel(member)}
                            className={`${styles.avatar} ${styles[`avatar_${member.avatarColor || 'ocean'}`]}`}
                            imageClassName={styles.avatarImage}
                          />
                          <div>
                            <div className={styles.contactName}>{member.displayName || member.username}</div>
                            <div className={styles.contactPreview}>{member.bio || member.email || member.username}</div>
                          </div>
                        </div>
                        <button type="button" className={styles.smallMutedButton} onClick={() => onUpdateGroupMembers({ addMemberIds: [member.id] })} disabled={isUpdatingGroupMembers}>
                          Добавить
                        </button>
                      </div>
                    ))}
                  </div>
                ) : <p className={styles.galleryEmpty}>Нет подходящих активных диалогов для добавления.</p>}
              </>
            ) : null}
          </>
        ) : null}
        <div className={styles.galleryHeaderRow}>
          <strong>Галерея</strong>
          <span>{galleryImages.length}</span>
        </div>
        {groupedGalleryImages.length ? (
          <div className={styles.galleryGroups}>
            {groupedGalleryImages.map((group) => (
              <section key={group.key} className={styles.galleryGroup}>
                <div className={styles.galleryGroupHeader}>{group.label}</div>
                <div className={styles.galleryGrid}>
                  {group.items.map((message) => (
                    <div key={message.id} className={styles.galleryCard}>
                      <button type="button" className={styles.galleryThumb} onClick={() => onPreviewImage({ src: message.attachment!.fileUrl, name: message.attachment!.fileName })}>
                        <img src={message.attachment!.fileUrl} alt={message.attachment!.fileName} className={styles.galleryThumbImage} loading="lazy" />
                      </button>
                      <button type="button" className={styles.galleryJumpButton} onClick={() => onJumpToMessage(message.id)}>
                        Перейти к сообщению
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : <p className={styles.galleryEmpty}>Пока нет изображений в этом диалоге.</p>}
      </div>
    </div>
  );
}
