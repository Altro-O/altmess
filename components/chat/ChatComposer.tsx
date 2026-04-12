'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage, Contact } from '../../utils/api';
import styles from '../../styles/chat.module.css';

interface ChatComposerProps {
  pageError: string;
  selectionMode: boolean;
  selectedMessageIds: string[];
  showForwardPicker: boolean;
  sidebarItems: Contact[];
  isForwardingMessages: boolean;
  uploadProgress: Array<{ name: string; progress: number }>;
  replyMessage: ChatMessage | null;
  replyQuote: string;
  showQuoteEditor: boolean;
  quoteDraft: string;
  selectedQuoteText: string;
  showUnifiedMobilePicker: boolean;
  mobilePickerTab: 'emoji' | 'sticker';
  orderedEmojis: string[];
  orderedStickerPacks: Array<{ key: string; title: string; items: string[] }>;
  isMobileLayout: boolean;
  isUploadingFile: boolean;
  showStickerPicker: boolean;
  showEmojiPicker: boolean;
  inputText: string;
  isRecordingVoice: boolean;
  voiceSeconds: number;
  activeContactId: string | null;
  getMessagePreview: (message?: ChatMessage | null) => string;
  onToggleForwardPicker: () => void;
  onClearMessageSelection: () => void;
  onForwardMessages: (contactId: string) => void;
  onOpenQuoteEditor: () => void;
  onClearReply: () => void;
  onCancelQuoteEditor: () => void;
  onApplyQuoteSelection: () => void;
  onSetMobilePickerTab: (tab: 'emoji' | 'sticker') => void;
  onAppendEmoji: (emoji: string) => void;
  onSendSticker: (packKey: string, fileUrl: string) => void;
  onSubmitMessage: (event: React.FormEvent) => void;
  onInputTextChange: (value: string) => void;
  onComposerKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onOpenFilePicker: () => void;
  onToggleStickerPicker: () => void;
  onToggleEmojiPicker: () => void;
  onToggleMobileUnifiedPicker: () => void;
  onStartVoiceRecording: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  composerTextareaRef: React.RefObject<HTMLTextAreaElement>;
  quoteSelectionRef: React.RefObject<HTMLDivElement>;
  onSendFile: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export default function ChatComposer(props: ChatComposerProps) {
  const {
    pageError,
    selectionMode,
    selectedMessageIds,
    showForwardPicker,
    sidebarItems,
    isForwardingMessages,
    uploadProgress,
    replyMessage,
    replyQuote,
    showQuoteEditor,
    quoteDraft,
    selectedQuoteText,
    showUnifiedMobilePicker,
    mobilePickerTab,
    orderedEmojis,
    orderedStickerPacks,
    isMobileLayout,
    isUploadingFile,
    showStickerPicker,
    showEmojiPicker,
    inputText,
    isRecordingVoice,
    voiceSeconds,
    activeContactId,
    getMessagePreview,
    onToggleForwardPicker,
    onClearMessageSelection,
    onForwardMessages,
    onOpenQuoteEditor,
    onClearReply,
    onCancelQuoteEditor,
    onApplyQuoteSelection,
    onSetMobilePickerTab,
    onAppendEmoji,
    onSendSticker,
    onSubmitMessage,
    onInputTextChange,
    onComposerKeyDown,
    onOpenFilePicker,
    onToggleStickerPicker,
    onToggleEmojiPicker,
    onToggleMobileUnifiedPicker,
    onStartVoiceRecording,
    fileInputRef,
    composerTextareaRef,
    quoteSelectionRef,
    onSendFile,
  } = props;

  const [activeStickerPackKey, setActiveStickerPackKey] = useState<string>('');

  useEffect(() => {
    if (!orderedStickerPacks.length) {
      setActiveStickerPackKey('');
      return;
    }

    if (!orderedStickerPacks.some((pack) => pack.key === activeStickerPackKey)) {
      setActiveStickerPackKey(orderedStickerPacks[0].key);
    }
  }, [activeStickerPackKey, orderedStickerPacks]);

  const activeStickerPack = useMemo(
    () => orderedStickerPacks.find((pack) => pack.key === activeStickerPackKey) || orderedStickerPacks[0] || null,
    [activeStickerPackKey, orderedStickerPacks],
  );

  const renderStickerPicker = (className?: string, compact = false) => (
    <div className={className ? `${styles.stickerPicker} ${className}` : styles.stickerPicker}>
      {compact ? (
        <label className={styles.stickerPackSelectWrap}>
          <span className={styles.stickerPackSelectLabel}>Пак</span>
          <select
            className={styles.stickerPackSelect}
            value={activeStickerPack?.key || ''}
            onChange={(event) => setActiveStickerPackKey(event.target.value)}
          >
            {orderedStickerPacks.map((pack) => (
              <option key={pack.key} value={pack.key}>{pack.title}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className={styles.stickerPackTabs}>
          {orderedStickerPacks.map((pack) => (
            <button
              key={pack.key}
              type="button"
              className={`${styles.stickerPackTab} ${activeStickerPack?.key === pack.key ? styles.stickerPackTabActive : ''}`}
              onClick={() => setActiveStickerPackKey(pack.key)}
            >
              {pack.title}
            </button>
          ))}
        </div>
      )}
      {activeStickerPack ? (
        <div className={styles.stickerPack}>
          <strong className={styles.stickerPackTitle}>{activeStickerPack.title}</strong>
          <div className={styles.stickerGrid}>
            {activeStickerPack.items.map((fileUrl) => (
              <button key={fileUrl} type="button" className={styles.stickerOption} onClick={() => onSendSticker(activeStickerPack.key, fileUrl)}>
                {fileUrl.endsWith('.webm') ? (
                  <video src={fileUrl} className={styles.stickerOptionImage} autoPlay muted loop playsInline preload="metadata" />
                ) : (
                  <img src={fileUrl} alt={activeStickerPack.title} className={styles.stickerOptionImage} loading="lazy" />
                )}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className={styles.composer}>
      {pageError ? <div className={styles.inlineError}>{pageError}</div> : null}
      {selectionMode ? (
        <div className={styles.replyBanner}>
          <button type="button" className={styles.replyBannerBody} onClick={onToggleForwardPicker}>
            <strong className={styles.replyBannerTitle}>Выбрано: {selectedMessageIds.length}</strong>
            <p className={styles.replyBannerText}>Нажмите, чтобы переслать выбранные сообщения</p>
          </button>
          <button type="button" className={styles.replyBannerClose} onClick={onClearMessageSelection}>X</button>
        </div>
      ) : null}
      {showForwardPicker && selectionMode ? (
        <div className={styles.quoteEditor}>
          <strong className={styles.quoteEditorTitle}>Куда переслать сообщения</strong>
          <div className={styles.quoteEditorActions} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            {sidebarItems.map((contact) => (
              <button key={contact.id} type="button" className={styles.smallMutedButton} onClick={() => onForwardMessages(contact.id)} disabled={isForwardingMessages}>
                {isForwardingMessages ? 'Пересылаем...' : `Переслать: ${contact.displayName || contact.username}`}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {uploadProgress.length ? (
        <div className={styles.uploadQueue}>
          {uploadProgress.map((entry) => (
            <div key={entry.name} className={styles.uploadQueueItem}>
              <div className={styles.uploadQueueMeta}>
                <strong>{entry.name}</strong>
                <span>{entry.progress}%</span>
              </div>
              <div className={styles.uploadBar}><span style={{ width: `${entry.progress}%` }} /></div>
            </div>
          ))}
        </div>
      ) : null}
      {replyMessage ? (
        <div className={styles.replyBanner}>
          <button type="button" className={styles.replyBannerBody} onClick={onOpenQuoteEditor} disabled={replyMessage.kind !== 'text' || !!replyMessage.deletedAt}>
            <strong className={styles.replyBannerTitle}>Ответ на сообщение</strong>
            <p className={styles.replyBannerText}>{replyQuote || getMessagePreview(replyMessage)}</p>
            {replyMessage.kind === 'text' && !replyMessage.deletedAt ? <span className={styles.replyBannerHint}>{replyQuote ? 'Нажмите, чтобы изменить цитату' : 'Нажмите, чтобы выбрать цитату'}</span> : null}
          </button>
          <button type="button" className={styles.replyBannerClose} onClick={onClearReply}>X</button>
        </div>
      ) : null}
      {showQuoteEditor && replyMessage?.kind === 'text' ? (
        <div className={styles.quoteEditor}>
          <strong className={styles.quoteEditorTitle}>Выберите фрагмент для цитаты</strong>
          <p className={styles.quoteEditorText}>Выделите нужный кусок текста. На iPhone кнопка снизу берет уже сохраненное выделение, поэтому оно не теряется при нажатии.</p>
          <div ref={quoteSelectionRef} className={styles.quoteEditorSelection}>
            {quoteDraft}
          </div>
          <div className={styles.quoteEditorSelectionState}>
            {selectedQuoteText ? `Выбрано: ${selectedQuoteText}` : 'Пока ничего не выбрано. Если нажать сейчас, процитируется весь текст.'}
          </div>
          <div className={styles.quoteEditorActions}>
            <button type="button" className={styles.smallMutedButton} onClick={onCancelQuoteEditor}>Отмена</button>
            <button type="button" className={styles.smallButton} onClick={onApplyQuoteSelection}>Цитировать</button>
          </div>
        </div>
      ) : null}
      {showUnifiedMobilePicker ? (
        <div className={styles.mobilePickerSheet}>
          <div className={styles.mobilePickerTabs}>
            <button type="button" className={`${styles.mobilePickerTab} ${mobilePickerTab === 'emoji' ? styles.mobilePickerTabActive : ''}`} onClick={() => onSetMobilePickerTab('emoji')}>
              Эмодзи
            </button>
            <button type="button" className={`${styles.mobilePickerTab} ${mobilePickerTab === 'sticker' ? styles.mobilePickerTabActive : ''}`} onClick={() => onSetMobilePickerTab('sticker')}>
              Стикеры
            </button>
          </div>
          {mobilePickerTab === 'emoji' ? (
            <div className={`${styles.emojiPicker} ${styles.mobilePickerBody}`}>
              {orderedEmojis.map((emoji) => (
                <button key={emoji} type="button" className={styles.emojiButton} onClick={() => onAppendEmoji(emoji)}>{emoji}</button>
              ))}
            </div>
          ) : (
            renderStickerPicker(styles.mobilePickerBody, true)
          )}
        </div>
      ) : null}
      {!isMobileLayout && showEmojiPicker ? (
        <div className={styles.emojiPicker}>
          {orderedEmojis.map((emoji) => (
            <button key={emoji} type="button" className={styles.emojiButton} onClick={() => onAppendEmoji(emoji)}>{emoji}</button>
          ))}
        </div>
      ) : null}
      {!isMobileLayout && showStickerPicker ? renderStickerPicker() : null}
      <form onSubmit={onSubmitMessage} className={styles.composerForm}>
        <div className={styles.composerInputWrap}>
          <textarea
            ref={composerTextareaRef}
            value={inputText}
            onChange={(event) => onInputTextChange(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Введите сообщение..."
            className={styles.composerInput}
            rows={1}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <div className={styles.composerInlineActions}>
            {isMobileLayout ? <button type="button" className={styles.inlineIconButton} title={isUploadingFile ? 'Загрузка...' : 'Прикрепить файл'} onClick={onOpenFilePicker}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M16.5 6.5a4.5 4.5 0 0 0-6.36 0l-5.3 5.3a3.25 3.25 0 1 0 4.6 4.6l5.47-5.47a2 2 0 1 0-2.83-2.83l-5.12 5.12a.75.75 0 0 0 1.06 1.06l4.77-4.77 1.06 1.06-4.77 4.77a2.25 2.25 0 0 1-3.18-3.18l5.12-5.12a3.5 3.5 0 1 1 4.95 4.95l-5.47 5.47a4.75 4.75 0 1 1-6.72-6.72l5.3-5.3a6 6 0 0 1 8.49 8.49l-4.95 4.95-1.06-1.06 4.95-4.95a4.5 4.5 0 0 0 0-6.36Z" fill="currentColor"/></svg>
            </button> : null}
            {!isMobileLayout ? <button type="button" className={`${styles.inlineIconButton} ${showStickerPicker ? styles.inlineIconButtonActive : ''}`} onClick={onToggleStickerPicker} title="Открыть стикеры">
              <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M6 3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5.59L8 21.41A1 1 0 0 1 6.29 20.7V17H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm2.75 6.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm6.5 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm-6.6 3.2a1 1 0 0 0-1.3 1.52 7 7 0 0 0 9.3 0 1 1 0 1 0-1.3-1.52 5 5 0 0 1-6.7 0Z" fill="currentColor"/></svg>
            </button> : null}
            <button type="button" className={`${styles.inlineIconButton} ${(showEmojiPicker || showStickerPicker) ? styles.inlineIconButtonActive : ''}`} onClick={isMobileLayout ? onToggleMobileUnifiedPicker : onToggleEmojiPicker} title={isMobileLayout ? 'Открыть эмодзи и стикеры' : 'Открыть эмодзи'}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20Zm-3.5-8a1 1 0 0 0-.8 1.6 5.5 5.5 0 0 0 8.6 0A1 1 0 0 0 14.7 14a3.5 3.5 0 0 1-5.4 0 1 1 0 0 0-.8-.4ZM9 10a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 9 10Zm6 0a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 15 10Z" fill="currentColor"/></svg>
            </button>
            {!inputText.trim() || isRecordingVoice ? (
              <button type="button" className={`${styles.inlineIconButton} ${isRecordingVoice ? styles.inlineIconButtonRecord : ''}`} onClick={onStartVoiceRecording} title={isRecordingVoice ? `Остановить запись ${voiceSeconds}s` : 'Записать голосовое'}>
                <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.07A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 1 0 10 0Z" fill="currentColor"/></svg>
                {isRecordingVoice ? <span className={styles.inlineIconText}>{voiceSeconds}s</span> : null}
              </button>
            ) : null}
          </div>
        </div>
        <input ref={fileInputRef} type="file" multiple className={styles.hiddenFileInput} onChange={onSendFile} accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar" />
        <button type="button" className={styles.iconButton} title={isUploadingFile ? 'Загрузка...' : 'Прикрепить файл'} onClick={onOpenFilePicker}>
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M16.5 6.5a4.5 4.5 0 0 0-6.36 0l-5.3 5.3a3.25 3.25 0 1 0 4.6 4.6l5.47-5.47a2 2 0 1 0-2.83-2.83l-5.12 5.12a.75.75 0 0 0 1.06 1.06l4.77-4.77 1.06 1.06-4.77 4.77a2.25 2.25 0 0 1-3.18-3.18l5.12-5.12a3.5 3.5 0 1 1 4.95 4.95l-5.47 5.47a4.75 4.75 0 1 1-6.72-6.72l5.3-5.3a6 6 0 0 1 8.49 8.49l-4.95 4.95-1.06-1.06 4.95-4.95a4.5 4.5 0 0 0 0-6.36Z" fill="currentColor"/></svg>
        </button>
        <button type="submit" className={styles.composerButton} aria-label="Отправить сообщение" title="Отправить" disabled={!activeContactId}>
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M3.4 11.3 18.8 4.7c1.5-.64 2.98.84 2.34 2.34L14.7 22.6c-.72 1.7-3.13 1.55-3.64-.22l-1.53-5.34-5.31-1.5c-1.8-.5-1.95-2.92-.24-3.65Zm6.95 4.08 1.27 4.44 6.09-14.2-14.2 6.1 4.46 1.26 6.3-6.3.88.88-6.3 6.3Z" fill="currentColor"/></svg>
        </button>
      </form>
    </div>
  );
}
