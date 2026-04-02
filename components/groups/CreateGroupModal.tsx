'use client';

import { useMemo, useState } from 'react';
import type { Contact } from '../../utils/api';
import UserAvatar from '../UserAvatar';
import styles from '../../styles/chat.module.css';

interface CreateGroupModalProps {
  contacts: Contact[];
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (title: string, memberIds: string[]) => void;
}

export default function CreateGroupModal({ contacts, isSubmitting, onClose, onSubmit }: CreateGroupModalProps) {
  const [title, setTitle] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const availableContacts = useMemo(
    () => contacts.filter((contact) => contact.type !== 'group'),
    [contacts],
  );

  const toggleContact = (contactId: string) => {
    setSelectedIds((prev) => (prev.includes(contactId) ? prev.filter((id) => id !== contactId) : [...prev, contactId]));
  };

  return (
    <div className={styles.dialogProfileBackdrop} onClick={onClose}>
      <div className={styles.dialogProfileSheet} onClick={(event) => event.stopPropagation()}>
        <div className={styles.dialogProfileHeader}>
          <div>
            <h3 className={styles.dialogProfileTitle}>Новая группа</h3>
            <p className={styles.dialogProfileText}>Выберите участников и задайте название чату.</p>
          </div>
        </div>

        <input
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className={styles.dialogSearchInput}
          placeholder="Название группы"
        />

        <p className={styles.dialogProfileText}>Выбрано участников: {selectedIds.length}</p>

        <div className={styles.contactList}>
          {availableContacts.length === 0 ? <p className={styles.galleryEmpty}>Пока нет контактов, которых можно добавить в группу.</p> : null}
          {availableContacts.map((contact) => {
            const selected = selectedIds.includes(contact.id);
            return (
              <button
                key={contact.id}
                type="button"
                className={`${styles.contact} ${selected ? styles.contactActive : ''}`}
                onClick={() => toggleContact(contact.id)}
              >
                <UserAvatar
                  avatarUrl={contact.avatarUrl}
                  alt={contact.displayName || contact.username}
                  fallback={(contact.displayName || contact.username).slice(0, 2).toUpperCase()}
                  className={`${styles.avatar} ${styles[`avatar_${contact.avatarColor || 'ocean'}`]}`}
                  imageClassName={styles.avatarImage}
                />
                <span className={styles.contactMeta}>
                  <span className={styles.contactName}>{contact.displayName || contact.username}</span>
                  <span className={styles.contactPreview}>{contact.bio || contact.email}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className={styles.dialogProfileActions}>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>Отмена</button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => onSubmit(title, selectedIds)}
            disabled={isSubmitting || !title.trim() || selectedIds.length === 0}
          >
            {isSubmitting ? 'Создаем...' : 'Создать группу'}
          </button>
        </div>
      </div>
    </div>
  );
}
