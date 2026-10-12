import { describe, expect, it, vi } from 'vitest';
import { RtcPeer } from './peer';
import type { CallSignalMessage } from './callSignaling';

class FakeTrack {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [new FakeTrack()]) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks.slice();
  }
  getTracks() {
    return this.tracks.slice();
  }
}

class FakePC {
  config: RTCConfiguration;
  onicecandidate: (event: { candidate?: unknown }) => void = () => {};
  ontrack: (event: unknown) => void = () => {};
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  candidates: unknown[] = [];
  addedTracks = 0;
  closed = false;

  constructor(config?: RTCConfiguration) {
    this.config = config ?? {};
  }

  async createOffer() {
    return { type: 'offer', sdp: 'OFFER-SDP' } satisfies RTCSessionDescriptionInit;
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'ANSWER-SDP' } satisfies RTCSessionDescriptionInit;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = d;
  }
  async addIceCandidate(candidate: unknown) {
    this.candidates.push(candidate);
  }
  addTrack(_track: unknown, _stream: unknown) {
    this.addedTracks += 1;
  }
  close() {
    this.closed = true;
  }
}

const signals: CallSignalMessage[] = [];

function makePeer(stream?: FakeStream) {
  const streamInst = stream ?? new FakeStream();
  const onRemoteStream = vi.fn();
  const onConnectionChange = vi.fn();
  const onError = vi.fn();
  const peer = new RtcPeer(
    {
      iceServers: [{ urls: 'stun:stun.example.com:19302' }],
      onSignal: (m) => signals.push(m),
      onRemoteStream,
      onConnectionChange,
      onError,
    },
    FakePC as unknown as new (config?: RTCConfiguration) => RTCPeerConnection,
    async () => streamInst as unknown as MediaStream,
  );
  const pc = peer['peer'] as unknown as FakePC;
  return { peer, pc, streamInst, onRemoteStream, onConnectionChange, onError };
}

describe('RtcPeer', () => {
  it('starts local media and attaches the audio track', async () => {
    const { peer, pc } = makePeer();
    const local = await peer.startLocalMedia();
    expect(local).toBeTruthy();
    expect(pc.addedTracks).toBe(1);
    expect(pc.config.iceServers).toHaveLength(1);
    peer.close();
  });

  it('creates the offer and forwards it via onSignal', async () => {
    const { peer, pc } = makePeer();
    await peer.startLocalMedia();
    signals.length = 0;
    await peer.createOffer();
    expect(pc.localDescription?.sdp).toBe('OFFER-SDP');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: 'offer', sdp: 'OFFER-SDP' });
    peer.close();
  });

  it('answers an incoming offer after local setup', async () => {
    const { peer, pc } = makePeer();
    await peer.startLocalMedia();
    signals.length = 0;
    await peer.acceptOffer('REMOTE-OFFER');
    expect(pc.remoteDescription?.sdp).toBe('REMOTE-OFFER');
    expect(signals[0]).toMatchObject({ type: 'answer', sdp: 'ANSWER-SDP' });
    peer.close();
  });

  it('queues ICE candidates until the remote description is set', async () => {
    const { peer, pc } = makePeer();
    await peer.startLocalMedia();
    await peer.addRemoteCandidate('{"candidate":"C1"}');
    expect(pc.candidates).toHaveLength(0);
    await peer.acceptOffer('REMOTE-OFFER');
    expect(pc.candidates.map((c) => (c as { candidate: string }).candidate)).toContain('C1');
    peer.close();
  });

  it('applies the answer for the caller', async () => {
    const { peer, pc } = makePeer();
    await peer.startLocalMedia();
    await peer.applyAnswer('ANSWER-FROM-CALLEE');
    expect(pc.remoteDescription?.sdp).toBe('ANSWER-FROM-CALLEE');
    peer.close();
  });

  it('mutes and unmutes the local audio track', async () => {
    const stream = new FakeStream();
    const { peer } = makePeer(stream);
    const track = stream.getAudioTracks()[0];
    await peer.startLocalMedia();
    peer.setMuted(true);
    expect(track.enabled).toBe(false);
    peer.setMuted(false);
    expect(track.enabled).toBe(true);
    peer.close();
  });

  it('reports remote streams, connection changes and closes cleanly', async () => {
    const { peer, pc, streamInst, onRemoteStream, onConnectionChange } = makePeer();
    pc.ontrack({ streams: [streamInst] });
    expect(onRemoteStream).toHaveBeenCalledWith(streamInst);
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    expect(onConnectionChange).toHaveBeenCalledWith('connected');
    await peer.startLocalMedia();
    peer.close();
    expect(pc.closed).toBe(true);
    expect(streamInst.getTracks()[0].stopped).toBe(true);
  });

  it('surfaces ICE failures', async () => {
    const { peer, pc, onError } = makePeer();
    pc.connectionState = 'failed';
    pc.iceConnectionState = 'failed';
    pc.oniceconnectionstatechange?.();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    peer.close();
  });
});