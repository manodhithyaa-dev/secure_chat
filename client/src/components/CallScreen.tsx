import { useEffect, useRef, useState } from 'react';
import { useChat } from '../features/chat/ChatContext';
import { Avatar } from './Sidebar';

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Full-screen overlay for the active/outgoing/connecting call. */
export default function CallScreen() {
  const chat = useChat();
  const call = chat.call;
  const [seconds, setSeconds] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setSeconds(0);
    if (call?.status !== 'active') return;
    const started = call.startedAt;
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    }, 500);
    return () => window.clearInterval(timer);
  }, [call?.callId, call?.status, call?.startedAt]);

  useEffect(() => {
    if (call?.video) {
      const local = localVideoRef.current;
      if (local && chat.localStream) {
        local.srcObject = chat.localStream;
        void local.play().catch(() => {});
      }
      const remote = remoteVideoRef.current;
      if (remote && chat.remoteStream) {
        remote.srcObject = chat.remoteStream;
        void remote.play().catch(() => {});
      }
      return;
    }
    const audio = audioRef.current;
    if (audio && chat.remoteStream) {
      audio.srcObject = chat.remoteStream;
      void audio.play().catch(() => {});
    }
  }, [call?.video, chat.remoteStream, chat.localStream]);

  if (!call) return null;

  const statusText =
    call.status === 'ringing'
      ? call.role === 'caller'
        ? 'Calling…'
        : 'Incoming call…'
      : call.status === 'connecting'
        ? 'Connecting…'
        : 'In call';

  const isVideo = call.video;

  return (
    <div className="call-screen" role="dialog" aria-label="Call in progress" data-testid="call-screen">
      {isVideo ? (
        <div className="call-video-stage">
          <video
            className="remote-video"
            ref={remoteVideoRef}
            data-testid="remote-video"
            autoPlay
            playsInline
          />
          <video
            className="local-video"
            ref={localVideoRef}
            data-testid="local-video"
            autoPlay
            muted
            playsInline
          />
          <div className="call-video-meta">
            <p className="call-status" data-testid="call-status">
              {statusText}
              {call.status === 'active' ? ` · ${formatClock(seconds)}` : ''}
            </p>
            <div className="call-actions">
              {call.role === 'caller' && call.status === 'ringing' && (
                <button className="mini" type="button" onClick={() => void chat.declineCall()}>
                  Cancel
                </button>
              )}
              <button
                className={`mini ${call.muted ? 'danger' : ''}`}
                type="button"
                onClick={chat.toggleMute}
                aria-pressed={call.muted}
                title={call.muted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {call.muted ? '🔇 Unmute' : '🔊 Mute'}
              </button>
              <button
                className="mini danger hangup"
                type="button"
                onClick={() => void chat.endCall()}
                data-testid="hangup-button"
              >
                ✕ Hang up
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="call-card">
          <Avatar name={call.peer.displayName} />
          <h2>{call.peer.displayName}</h2>
          <p className="call-status" data-testid="call-status">
            {statusText}
            {call.status === 'active' ? ` · ${formatClock(seconds)}` : ''}
          </p>
          <div className="call-actions">
            {call.role === 'caller' && call.status === 'ringing' && (
              <button className="mini" type="button" onClick={() => void chat.declineCall()}>
                Cancel
              </button>
            )}
            <button
              className={`mini ${call.muted ? 'danger' : ''}`}
              type="button"
              onClick={chat.toggleMute}
              aria-pressed={call.muted}
              title={call.muted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {call.muted ? '🔇 Unmute' : '🔊 Mute'}
            </button>
            <button
              className="mini danger hangup"
              type="button"
              onClick={() => void chat.endCall()}
              data-testid="hangup-button"
            >
              ✕ Hang up
            </button>
          </div>
        </div>
      )}
      {!isVideo && <audio ref={audioRef} autoPlay />}
    </div>
  );
}