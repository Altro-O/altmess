'use client';

import { useCallback, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { type CallSession } from '../components/VideoCall';
import { type GroupCallSession } from '../components/GroupCall';
import { type Contact } from '../utils/api';

export interface UseCallParams {
  socketRef: React.RefObject<Socket | null>;
  setPageError: (error: string) => void;
}

export function useCall({
  socketRef,
  setPageError,
}: UseCallParams) {
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const [callOverlayVisible, setCallOverlayVisible] = useState(true);
  const [groupCallSession, setGroupCallSession] = useState<GroupCallSession | null>(null);

  const handleCallIncoming = useCallback(({ callId, mode, fromUser }: { callId: string; mode: 'audio' | 'video'; fromUser: Contact }) => {
    setCallSession({
      callId,
      peerUserId: fromUser.id,
      peerName: fromUser.displayName || fromUser.username,
      peerAvatarUrl: fromUser.avatarUrl,
      peerAvatarColor: fromUser.avatarColor,
      mode,
      initiator: false,
    });
    setCallOverlayVisible(true);
  }, []);

  const handleGroupCallIncoming = useCallback(({ groupId, mode, title, fromUser }: { groupId: string; mode: 'audio' | 'video'; title: string; fromUser: Contact }) => {
    setGroupCallSession({
      groupId,
      mode,
      title,
      initiator: false,
      incomingFrom: fromUser,
    });
  }, []);

  const handleCallEndedCallback = useCallback(({ callId }: { callId: string }) => {
    setCallSession((prev) => (prev?.callId === callId ? null : prev));
    setCallOverlayVisible(true);
  }, []);

  const handleGroupCallEndedCallback = useCallback(({ groupId }: { groupId: string }) => {
    setGroupCallSession((current) => (current?.groupId === groupId ? null : current));
  }, []);

  const handleCloseCall = useCallback(() => {
    setCallSession(null);
    setCallOverlayVisible(true);
  }, []);

  const handleCloseGroupCall = useCallback(() => {
    setGroupCallSession(null);
  }, []);

  const handleMinimizeCall = useCallback(() => {
    setCallOverlayVisible(false);
  }, []);

  const handleRestoreCall = useCallback(() => {
    setCallOverlayVisible(true);
  }, []);

  const requestCallMediaAccess = async (mode: 'audio' | 'video') => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Браузер не поддерживает доступ к микрофону/камере');
    }

    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: mode === 'video',
      });
    } catch (error) {
      if (mode === 'video') {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          video: false,
        });
      } else {
        throw error;
      }
    }

    const hasAudioTrack = stream.getAudioTracks().length > 0;
    stream.getTracks().forEach((track) => track.stop());

    if (!hasAudioTrack) {
      throw new Error('Не удалось получить доступ к микрофону');
    }
  };

  const startCall = async (mode: 'audio' | 'video', activeContact: Contact) => {
    if (!socketRef.current) return;

    try {
      await requestCallMediaAccess(mode);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Нужен доступ к микрофону и камере для звонка');
      return;
    }

    socketRef.current.emit('call:start', { toUserId: activeContact.id, mode }, (response: { ok: boolean; callId?: string; error?: string }) => {
      if (!response.ok || !response.callId) {
        setPageError(response.error || 'Не удалось начать звонок');
        return;
      }

      setCallSession({
        callId: response.callId,
        peerUserId: activeContact.id,
        peerName: activeContact.displayName || activeContact.username,
        peerAvatarUrl: activeContact.avatarUrl,
        peerAvatarColor: activeContact.avatarColor,
        mode,
        initiator: true,
      });
      setCallOverlayVisible(true);
    });
  };

  const startGroupCall = async (mode: 'audio' | 'video', activeContact: Contact) => {
    if (!socketRef.current || activeContact.type !== 'group') return;

    try {
      await requestCallMediaAccess(mode);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Нужен доступ к микрофону и камере для звонка');
      return;
    }

    socketRef.current.emit('group-call:start', { groupId: activeContact.id.slice('group:'.length), mode }, (response: { ok: boolean; error?: string; room?: { groupId: string; title: string; mode: 'audio' | 'video' } }) => {
      if (!response.ok || !response.room) {
        setPageError(response.error || 'Не удалось начать групповой звонок');
        return;
      }

      setGroupCallSession({
        groupId: response.room.groupId,
        title: response.room.title,
        mode: response.room.mode,
        initiator: true,
        incomingFrom: null,
      });
      setPageError('');
    });
  };

  return {
    callSession,
    callOverlayVisible,
    groupCallSession,
    handleCallIncoming,
    handleGroupCallIncoming,
    handleCallEndedCallback,
    handleGroupCallEndedCallback,
    handleCloseCall,
    handleCloseGroupCall,
    handleMinimizeCall,
    handleRestoreCall,
    startCall,
    startGroupCall,
  };
}
