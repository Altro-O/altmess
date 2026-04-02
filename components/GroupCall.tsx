'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { Contact } from '../utils/api';
import styles from '../styles/videoCall.module.css';
import UserAvatar from './UserAvatar';

export interface GroupCallSession {
  groupId: string;
  title: string;
  mode: 'audio' | 'video';
  initiator: boolean;
  incomingFrom?: Contact | null;
}

interface GroupCallProps {
  socket: Socket;
  call: GroupCallSession;
  currentUserId: string;
  iceServers: RTCIceServer[];
  onClose: () => void;
}

function getFallbackLabel(user: Pick<Contact, 'displayName' | 'username'>) {
  return (user.displayName || user.username || '?').slice(0, 2).toUpperCase();
}

export default function GroupCall({ socket, call, currentUserId, iceServers, onClose }: GroupCallProps) {
  const [phase, setPhase] = useState(call.initiator ? 'connecting' : 'incoming');
  const [notice, setNotice] = useState('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(call.mode === 'video');
  const [participants, setParticipants] = useState<Record<string, Contact>>({});
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const closingRef = useRef(false);

  const activeParticipants = useMemo(
    () => Object.entries(participants).filter(([userId]) => userId !== currentUserId),
    [currentUserId, participants],
  );

  const createLocalMedia = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: call.mode === 'video'
        ? {
            facingMode: { ideal: 'user' },
            width: { ideal: 640, max: 960 },
            height: { ideal: 360, max: 540 },
            frameRate: { ideal: 24, max: 30 },
          }
        : false,
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  };

  const cleanupPeer = (userId: string) => {
    const connection = peerConnectionsRef.current.get(userId);
    if (connection) {
      connection.onicecandidate = null;
      connection.ontrack = null;
      connection.close();
      peerConnectionsRef.current.delete(userId);
    }
    setRemoteStreams((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  };

  const cleanupAll = () => {
    peerConnectionsRef.current.forEach((connection) => connection.close());
    peerConnectionsRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStreams({});
  };

  const ensurePeerConnection = (user: Contact) => {
    const existing = peerConnectionsRef.current.get(user.id);
    if (existing) {
      return existing;
    }

    const connection = new RTCPeerConnection({ iceServers });
    localStreamRef.current?.getTracks().forEach((track) => connection.addTrack(track, localStreamRef.current!));

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      socket.emit('group-call:ice-candidate', {
        groupId: call.groupId,
        targetUserId: user.id,
        candidate: event.candidate,
      });
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) {
        return;
      }

      setRemoteStreams((prev) => ({ ...prev, [user.id]: stream }));
    };

    peerConnectionsRef.current.set(user.id, connection);
    return connection;
  };

  const createOfferForUser = async (user: Contact) => {
    const connection = ensurePeerConnection(user);
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    socket.emit('group-call:offer', {
      groupId: call.groupId,
      targetUserId: user.id,
      offer,
    });
  };

  const joinCall = async () => {
    try {
      setNotice('Подключаем группу...');
      localStreamRef.current || await createLocalMedia();
      await new Promise<void>((resolve, reject) => {
        socket.emit('group-call:join', { groupId: call.groupId }, async (response: { ok: boolean; error?: string; room?: { participants: Contact[] } }) => {
          if (!response?.ok || !response.room) {
            reject(new Error(response?.error || 'Не удалось войти в групповой звонок'));
            return;
          }

          const participantMap = response.room.participants.reduce<Record<string, Contact>>((acc, participant) => {
            acc[participant.id] = participant;
            return acc;
          }, {});
          setParticipants((prev) => ({ ...prev, ...participantMap }));

          resolve();
        });
      });

      setPhase('active');
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось подключиться к групповому звонку');
      setPhase('error');
    }
  };

  useEffect(() => {
    if (!call.initiator) {
      return;
    }

    joinCall();
  }, [call.initiator]);

  useEffect(() => {
    const handleIncomingOffer = async ({ groupId, fromUserId, offer }: { groupId: string; fromUserId: string; offer: RTCSessionDescriptionInit }) => {
      if (groupId !== call.groupId) {
        return;
      }

      const user = participants[fromUserId] || {
        id: fromUserId,
        username: 'Участник',
        displayName: 'Участник',
        email: '',
        online: false,
      };

      if (!participants[fromUserId]) {
        setParticipants((prev) => ({ ...prev, [fromUserId]: user }));
      }

      const connection = ensurePeerConnection(user);
      await connection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      socket.emit('group-call:answer', {
        groupId: call.groupId,
        targetUserId: fromUserId,
        answer,
      });
    };

    const handleIncomingAnswer = async ({ groupId, fromUserId, answer }: { groupId: string; fromUserId: string; answer: RTCSessionDescriptionInit }) => {
      if (groupId !== call.groupId) {
        return;
      }

      const connection = peerConnectionsRef.current.get(fromUserId);
      if (!connection) {
        return;
      }

      await connection.setRemoteDescription(new RTCSessionDescription(answer));
    };

    const handleIncomingCandidate = async ({ groupId, fromUserId, candidate }: { groupId: string; fromUserId: string; candidate: RTCIceCandidateInit }) => {
      if (groupId !== call.groupId) {
        return;
      }

      const connection = peerConnectionsRef.current.get(fromUserId);
      if (!connection) {
        return;
      }

      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    };

    const handleUserJoined = ({ groupId, user }: { groupId: string; user: Contact }) => {
      if (groupId !== call.groupId || user.id === currentUserId) {
        return;
      }

      setParticipants((prev) => ({ ...prev, [user.id]: user }));

      if (localStreamRef.current && phase === 'active') {
        createOfferForUser(user).catch((error) => {
          console.error('Failed to create group call offer for joined user:', error);
        });
      }
    };

    const handleUserLeft = ({ groupId, userId }: { groupId: string; userId: string }) => {
      if (groupId !== call.groupId) {
        return;
      }

      cleanupPeer(userId);
      setParticipants((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    };

    const handleEnded = ({ groupId }: { groupId: string }) => {
      if (groupId !== call.groupId) {
        return;
      }

      cleanupAll();
      onClose();
    };

    socket.on('group-call:offer', handleIncomingOffer);
    socket.on('group-call:answer', handleIncomingAnswer);
    socket.on('group-call:ice-candidate', handleIncomingCandidate);
    socket.on('group-call:user-joined', handleUserJoined);
    socket.on('group-call:user-left', handleUserLeft);
    socket.on('group-call:ended', handleEnded);

    return () => {
      socket.off('group-call:offer', handleIncomingOffer);
      socket.off('group-call:answer', handleIncomingAnswer);
      socket.off('group-call:ice-candidate', handleIncomingCandidate);
      socket.off('group-call:user-joined', handleUserJoined);
      socket.off('group-call:user-left', handleUserLeft);
      socket.off('group-call:ended', handleEnded);
    };
  }, [call.groupId, currentUserId, onClose, participants, phase, socket]);

  useEffect(() => () => {
    if (!closingRef.current) {
      socket.emit('group-call:leave', { groupId: call.groupId });
    }
    cleanupAll();
  }, [call.groupId, socket]);

  const leaveCall = () => {
    closingRef.current = true;
    socket.emit('group-call:leave', { groupId: call.groupId }, () => {
      cleanupAll();
      onClose();
    });
  };

  const acceptIncomingCall = async () => {
    await joinCall();
  };

  const declineIncomingCall = () => {
    onClose();
  };

  const toggleAudio = () => {
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setAudioEnabled(track.enabled);
    });
  };

  const toggleVideo = () => {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setVideoEnabled(track.enabled);
    });
  };

  return (
    <div className={styles.overlay} style={{ display: 'block' }}>
      <div className={styles.backdrop} />

      {phase === 'incoming' ? (
        <div className={styles.incoming}>
          <div className={styles.incomingCard}>
            <UserAvatar
              avatarUrl={call.incomingFrom?.avatarUrl}
              alt={call.incomingFrom?.displayName || call.incomingFrom?.username || call.title}
              fallback={call.incomingFrom ? getFallbackLabel(call.incomingFrom) : call.title.slice(0, 2).toUpperCase()}
              className={`${styles.incomingAvatar} ${styles[`incomingAvatar_${call.incomingFrom?.avatarColor || 'berry'}`]}`}
              imageClassName={styles.incomingAvatarImage}
            />
            <h3 className={styles.incomingTitle}>{call.mode === 'video' ? 'Групповой видеозвонок' : 'Групповой аудиозвонок'}</h3>
            <p className={styles.incomingText}>{call.incomingFrom?.displayName || call.incomingFrom?.username} приглашает в {call.title}</p>
            <div className={styles.incomingActions}>
              <button className={styles.dangerWide} onClick={declineIncomingCall}><span className={styles.controlLabel}>Отклонить</span></button>
              <button className={styles.acceptWide} onClick={acceptIncomingCall}><span className={styles.controlLabel}>Войти</span></button>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.callScreen}>
          <div className={styles.topBar}>
            <strong>{call.title}</strong>
            <span>{call.mode === 'video' ? 'Групповой видеозвонок' : 'Групповой аудиозвонок'}</span>
            {notice ? <p className={styles.notice}>{notice}</p> : null}
          </div>

          <div className={styles.groupStage}>
            <div className={styles.groupGrid}>
              <div className={styles.groupTile}>
                {call.mode === 'video' && localStream ? (
                  <video
                    className={styles.groupVideo}
                    ref={(node) => {
                      if (node && localStream) {
                        node.srcObject = localStream;
                        node.muted = true;
                        void node.play().catch(() => null);
                      }
                    }}
                    playsInline
                    autoPlay
                    muted
                  />
                ) : (
                  <div className={styles.audioStageMini}>Вы</div>
                )}
                <div className={styles.groupTileLabel}>Вы</div>
              </div>

              {activeParticipants.map(([userId, user]) => (
                <div key={userId} className={styles.groupTile}>
                  {call.mode === 'video' && remoteStreams[userId] ? (
                    <video
                      className={styles.groupVideo}
                      ref={(node) => {
                        if (node && remoteStreams[userId]) {
                          node.srcObject = remoteStreams[userId];
                          void node.play().catch(() => null);
                        }
                      }}
                      playsInline
                      autoPlay
                    />
                ) : (
                  <div className={styles.audioStageMini}>{getFallbackLabel(user)}</div>
                )}
                <div className={styles.groupTileLabel}>{user.displayName || user.username}</div>
                {remoteStreams[userId] ? (
                  <audio
                    ref={(node) => {
                      if (node && remoteStreams[userId]) {
                        node.srcObject = remoteStreams[userId];
                        node.muted = false;
                        void node.play().catch(() => null);
                      }
                    }}
                    autoPlay
                    playsInline
                    className={styles.remoteAudio}
                  />
                ) : null}
              </div>
            ))}
            </div>
          </div>

          <div className={styles.controls}>
            <button className={styles.controlWide} onClick={toggleAudio}><span className={styles.controlTitle}>{audioEnabled ? 'Микрофон вкл' : 'Микрофон выкл'}</span></button>
            {call.mode === 'video' ? <button className={styles.controlWide} onClick={toggleVideo}><span className={styles.controlTitle}>{videoEnabled ? 'Камера вкл' : 'Камера выкл'}</span></button> : null}
            <button className={styles.dangerWide} onClick={leaveCall}><span className={styles.controlTitle}>Выйти</span></button>
          </div>
        </div>
      )}
    </div>
  );
}
