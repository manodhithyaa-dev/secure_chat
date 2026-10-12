import type { CallSignalMessage } from './callSignaling';

/**
 * Thin RTCPeerConnection wrapper for 1:1 audio calls. The ChatContext owns
 * the signaling socket; this class owns the media + ICE machinery and reports
 * anything it must send through the `onSignal` callback.
 *
 * The underlying PC constructor and getUserMedia are injectable so the module
 * stays unit-testable in Node (no real WebRTC required).
 */

export interface RtcPeerHooks {
  iceServers?: RTCIceServer[];
  /** `video` also captures a camera track (used for video calls). */
  mode?: 'audio' | 'video';
  onSignal: (message: CallSignalMessage) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionChange?: (state: RTCPeerConnectionState) => void;
  onError?: (err: Error) => void;
}

export class RtcPeer {
  private peer: RTCPeerConnection | null;
  private localStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionApplied = false;
  private tracksEnded = false;

  constructor(
    private hooks: RtcPeerHooks,
    pcFactory: new (config?: RTCConfiguration) => RTCPeerConnection = RTCPeerConnection,
    private getUserMediaImpl: (constraints: MediaStreamConstraints) => Promise<MediaStream> = (
      constraints,
    ) => navigator.mediaDevices.getUserMedia(constraints),
  ) {
    this.peer = new pcFactory({ iceServers: hooks.iceServers ?? [] });
    this.attachListeners();
  }

  private attachListeners() {
    const peer = this.peer;
    if (!peer) return;
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.hooks.onSignal({
          type: 'candidate',
          candidate: JSON.stringify(event.candidate.toJSON()),
        });
      }
    };
    peer.ontrack = (event) => {
      this.hooks.onRemoteStream(event.streams[0]);
    };
    peer.onconnectionstatechange = () => {
      this.hooks.onConnectionChange?.(peer.connectionState);
    };
    peer.oniceconnectionstatechange = () => {
      if (
        peer.iceConnectionState === 'failed' &&
        peer.connectionState !== 'closed'
      ) {
        this.hooks.onError?.(new Error('ICE connection failed'));
      }
    };
  }

  async startLocalMedia() {
    if (this.localStream) return this.localStream;
    const video = this.hooks.mode === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 } } : false;
    const stream = await this.getUserMediaImpl({
      audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
      video,
    });
    this.localStream = stream;
    for (const track of stream.getTracks()) {
      this.peer?.addTrack(track, stream);
    }
    return stream;
  }

  getLocalStream() {
    return this.localStream;
  }

  /** Caller side: create the offer and send it via signaling. */
  async createOffer() {
    const peer = this.peer;
    if (!peer) return;
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    this.flushPendingCandidates();
    this.hooks.onSignal({ type: 'offer', sdp: offer.sdp });
  }

  /** Callee side: accept the remote offer and answer. */
  async acceptOffer(sdp: string) {
    const peer = this.peer;
    if (!peer) return;
    await peer.setRemoteDescription({ type: 'offer', sdp });
    this.remoteDescriptionApplied = true;
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    this.flushPendingCandidates();
    this.hooks.onSignal({ type: 'answer', sdp: answer.sdp });
  }

  async applyAnswer(sdp: string) {
    const peer = this.peer;
    if (!peer) return;
    await peer.setRemoteDescription({ type: 'answer', sdp });
    this.remoteDescriptionApplied = true;
  }

  async addRemoteCandidate(candidateJson: string) {
    const peer = this.peer;
    if (!peer) return;
    const candidate = JSON.parse(candidateJson) as RTCIceCandidateInit;
    if (!this.remoteDescriptionApplied) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await peer.addIceCandidate(candidate);
  }

  private flushPendingCandidates() {
    const peer = this.peer;
    if (!peer || !this.remoteDescriptionApplied) return;
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      void peer.addIceCandidate(candidate).catch(() => {});
    }
  }

  setMuted(muted: boolean) {
    const stream = this.localStream;
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }

  close() {
    if (this.tracksEnded) return;
    this.tracksEnded = true;
    const stream = this.localStream;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      this.localStream = null;
    }
    this.peer?.close();
    this.peer = null;
  }
}