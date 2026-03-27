'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import styles from '../styles/videoCall.module.css';

export interface CallSession {
  callId: string;
  peerUserId: string;
  peerName: string;
  mode: 'audio' | 'video';
  initiator: boolean;
}

interface VideoCallProps {
  socket: Socket;
  call: CallSession;
  iceServers: RTCIceServer[];
  minimized?: boolean;
  onMinimize?: () => void;
  onRestore?: () => void;
  onClose: () => void;
}

export default function VideoCall({ socket, call, iceServers, onClose }: VideoCallProps) {
  const [phase, setPhase] = useState(call.initiator ? 'outgoing' : 'incoming');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(call.mode === 'video');
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDisconnectTimer = () => {
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
  };

  const ensureRemotePlayback = async () => {
    try {
      await remoteAudioRef.current?.play();
    } catch {
      return;
    }
  };

  const getMediaConstraints = (): MediaStreamConstraints => ({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: call.mode === 'video'
      ? {
          facingMode: 'user',
          width: { ideal: 640, max: 960 },
          height: { ideal: 360, max: 540 },
          frameRate: { ideal: 24, max: 30 },
        }
      : false,
  });

  useEffect(() => {
    setPhase(call.initiator ? 'outgoing' : 'incoming');
    setVideoEnabled(call.mode === 'video');
    setVideoUnavailable(false);
    clearDisconnectTimer();
  }, [call]);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current
        .play()
        .catch(() => null);
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.muted = false;
      remoteAudioRef.current.volume = 1;
    }

    remoteStreamRef.current = remoteStream;
    ensureRemotePlayback();
  }, [remoteStream]);

  const closeResources = () => {
    clearDisconnectTimer();
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);

    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;
    setRemoteStream(null);
    pendingIceCandidatesRef.current = [];
  };

  useEffect(() => {
    const handleAccepted = ({ callId }: { callId: string }) => {
      if (callId !== call.callId || !call.initiator) {
        return;
      }

      startAsCaller().catch((error) => {
        console.error('Failed to start caller flow:', error);
        setPhase('error');
      });
    };

    const handleRejected = ({ callId }: { callId: string }) => {
      if (callId !== call.callId) {
        return;
      }

      setPhase('rejected');
      closeResources();
      onClose();
    };

    const handleEnded = ({ callId }: { callId: string }) => {
      if (callId !== call.callId) {
        return;
      }

      setPhase('ended');
      closeResources();
      onClose();
    };

    const handleMissed = ({ callId }: { callId: string }) => {
      if (callId !== call.callId) {
        return;
      }

      setPhase('missed');
      closeResources();
      onClose();
    };

    const handleOffer = async ({ callId, offer }: { callId: string; offer: RTCSessionDescriptionInit }) => {
      if (callId !== call.callId || call.initiator) {
        return;
      }

      try {
        const stream = localStreamRef.current || (await createLocalMedia());
        const peerConnection = createPeerConnection(stream);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        while (pendingIceCandidatesRef.current.length > 0) {
          const queuedCandidate = pendingIceCandidatesRef.current.shift();
          if (queuedCandidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(queuedCandidate));
          }
        }
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('webrtc:answer', { callId: call.callId, answer });
        setPhase('active');
        ensureRemotePlayback();
      } catch (error) {
        console.error('Failed to handle offer:', error);
        setPhase('error');
      }
    };

    const handleAnswer = async ({ callId, answer }: { callId: string; answer: RTCSessionDescriptionInit }) => {
      if (callId !== call.callId || !call.initiator || !peerConnectionRef.current) {
        return;
      }

      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      while (pendingIceCandidatesRef.current.length > 0) {
        const queuedCandidate = pendingIceCandidatesRef.current.shift();
        if (queuedCandidate) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(queuedCandidate));
        }
      }
      setPhase('active');
      ensureRemotePlayback();
    };

    const handleIceCandidate = async ({ callId, candidate }: { callId: string; candidate: RTCIceCandidateInit }) => {
      if (callId !== call.callId || !peerConnectionRef.current || !candidate) {
        return;
      }

      try {
        if (!peerConnectionRef.current.remoteDescription) {
          pendingIceCandidatesRef.current.push(candidate);
          return;
        }

        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('Failed to add ICE candidate:', error);
      }
    };

    socket.on('call:accepted', handleAccepted);
    socket.on('call:rejected', handleRejected);
    socket.on('call:ended', handleEnded);
    socket.on('call:missed', handleMissed);
    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice-candidate', handleIceCandidate);

    return () => {
      socket.off('call:accepted', handleAccepted);
      socket.off('call:rejected', handleRejected);
      socket.off('call:ended', handleEnded);
      socket.off('call:missed', handleMissed);
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice-candidate', handleIceCandidate);
      closeResources();
    };
  }, [call, onClose, socket]);

  const createLocalMedia = async () => {
    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
      setVideoUnavailable(false);
    } catch (error) {
      if (call.mode !== 'video') {
        const nextError = error instanceof Error ? error : new Error('Не удалось получить доступ к микрофону');
        throw nextError;
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      setVideoUnavailable(true);
      setVideoEnabled(false);
    }

    localStreamRef.current = stream;
    stream.getAudioTracks().forEach((track) => {
      track.contentHint = 'speech';
    });
    stream.getVideoTracks().forEach((track) => {
      track.contentHint = 'motion';
    });
    setLocalStream(stream);
    setAudioEnabled(stream.getAudioTracks().some((track) => track.enabled));
    setVideoEnabled(stream.getVideoTracks().some((track) => track.enabled));
    return stream;
  };

  const createPeerConnection = (stream: MediaStream) => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const peerConnection = new RTCPeerConnection({ iceServers });
    const incomingStream = new MediaStream();

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc:ice-candidate', {
          callId: call.callId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    peerConnection.ontrack = (event) => {
      if (event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!incomingStream.getTracks().some((existingTrack) => existingTrack.id === track.id)) {
            incomingStream.addTrack(track);
          }
        });
      } else if (event.track && !incomingStream.getTracks().some((existingTrack) => existingTrack.id === event.track.id)) {
        incomingStream.addTrack(event.track);
      }

      setRemoteStream(incomingStream);
      setPhase('active');
      clearDisconnectTimer();
      ensureRemotePlayback();
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'connected') {
        setPhase('active');
        clearDisconnectTimer();
      }

      if (peerConnection.connectionState === 'failed') {
        setPhase('error');
        closeResources();
        onClose();
      }

      if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'closed') {
        clearDisconnectTimer();
        disconnectTimerRef.current = setTimeout(() => {
          setPhase('ended');
          closeResources();
          onClose();
        }, 1200);
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (peerConnection.iceConnectionState === 'failed') {
        setPhase('error');
      }
    };

    stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

    peerConnection.getSenders().forEach((sender) => {
      if (!sender.track) {
        return;
      }

      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings || [{}];

      if (sender.track.kind === 'audio') {
        parameters.encodings[0].maxBitrate = 32000;
      }

      if (sender.track.kind === 'video') {
        parameters.encodings[0].maxBitrate = 700000;
        parameters.encodings[0].maxFramerate = 24;
      }

      sender.setParameters(parameters).catch(() => null);
    });

    if (call.mode === 'video' && stream.getVideoTracks().length === 0) {
      peerConnection.addTransceiver('video', { direction: 'recvonly' });
    }

    peerConnectionRef.current = peerConnection;
    return peerConnection;
  };

  const startAsCaller = async () => {
    setPhase('connecting');
    const stream = localStreamRef.current || (await createLocalMedia());
    const peerConnection = createPeerConnection(stream);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc:offer', { callId: call.callId, offer });
  };

  const acceptCall = async () => {
    try {
      await createLocalMedia();
      await ensureRemotePlayback();
      setPhase('connecting');
      socket.emit('call:accept', { callId: call.callId });
    } catch (error) {
      console.error('Failed to access media devices:', error);
      alert(error instanceof Error ? error.message : 'Нужен доступ к микрофону и камере для звонка');
      setPhase('error');
    }
  };

  const rejectCall = () => {
    socket.emit('call:reject', { callId: call.callId });
    closeResources();
    onClose();
  };

  const endCall = () => {
    socket.emit('call:end', { callId: call.callId });
    closeResources();
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

  const closeOverlay = () => {
    closeResources();
    onClose();
  };

  const statusText = useMemo(() => {
    if (phase === 'incoming') return 'Входящий звонок';
    if (phase === 'outgoing') return 'Ожидаем ответ';
    if (phase === 'connecting') return 'Соединяем';
    if (phase === 'active') return call.mode === 'video' ? 'Видеозвонок активен' : 'Голосовой звонок активен';
    if (phase === 'rejected') return 'Звонок отклонен';
    if (phase === 'error') return 'Ошибка подключения';
    if (phase === 'missed') return 'Звонок пропущен';
    return 'Звонок завершен';
  }, [call.mode, phase]);

  return (
    <div className={styles.overlay} style={{ display: 'block' }}>
      <div className={styles.backdrop} />

      {phase === 'incoming' ? (
        <div className={styles.incoming}>
          <div className={styles.incomingCard}>
            <div className={styles.incomingAvatar}>{call.peerName.slice(0, 1).toUpperCase()}</div>
            <h3 className={styles.incomingTitle}>{call.mode === 'video' ? 'Видеозвонок' : 'Голосовой звонок'}</h3>
            <p className={styles.incomingText}>От {call.peerName}</p>
            <div className={styles.incomingActions}>
              <button className={styles.dangerWide} onClick={rejectCall}>
                <span className={styles.controlLabel}>Отклонить</span>
              </button>
              <button className={styles.acceptWide} onClick={acceptCall}>
                <span className={styles.controlLabel}>Ответить</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.callScreen}>
          <div className={styles.topBar}>
            <strong>{call.peerName}</strong>
            <span>{statusText}</span>
          </div>

          {call.mode === 'video' ? (
            <video ref={remoteVideoRef} autoPlay playsInline className={styles.remoteVideo} />
          ) : (
            <div className={styles.audioStage}>
              <div className={styles.audioPulse}>{call.peerName.slice(0, 1).toUpperCase()}</div>
            </div>
          )}

          <audio ref={remoteAudioRef} autoPlay playsInline preload="auto" className={styles.remoteAudio} />

          <div className={styles.localCard}>
            {call.mode === 'video' ? (
              localStream?.getVideoTracks().length ? (
                <video ref={localVideoRef} autoPlay playsInline muted className={styles.localVideo} />
              ) : (
                <div className={styles.audioStageMini}>{videoUnavailable ? 'Без камеры' : 'Микрофон'}</div>
              )
            ) : (
              <div className={styles.audioStageMini}>Микрофон</div>
            )}
            <div className={styles.localBadge}>Вы</div>
          </div>

          <div className={styles.controls}>
            <button className={styles.controlWide} onClick={toggleAudio}>
              <span className={styles.controlTitle}>{audioEnabled ? 'Микрофон вкл' : 'Микрофон выкл'}</span>
            </button>
            <button className={styles.dangerWide} onClick={endCall}>
              <span className={styles.controlTitle}>Завершить</span>
            </button>
            {call.mode === 'video' ? (
              <button className={styles.controlWide} onClick={toggleVideo}>
                <span className={styles.controlTitle}>{videoEnabled ? 'Камера вкл' : 'Камера выкл'}</span>
              </button>
            ) : (
              <button className={styles.controlWide} onClick={closeOverlay}>
                <span className={styles.controlTitle}>Скрыть</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
