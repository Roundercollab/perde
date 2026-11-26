let soundContext, workletReady, captureSource, captureProcessor;
let relayWanted = false;
const voiceRoutes = new Map();
const peerVolumes = new Map();
const directMixers = new Map();

function unlockRoomAudio() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return;
  if (!soundContext) {
    soundContext = new Context();
    soundContext.addEventListener("statechange", () => {
      for (const id of remoteAudioEls.keys()) updateVoiceOutput(id);
    });
  }
  if (soundContext.state === "suspended") soundContext.resume().catch(() => {});
}
joinForm.addEventListener("submit", unlockRoomAudio);
document.addEventListener("click", () => { if (roomCode) unlockRoomAudio(); });

function disconnectCapture() {
  captureSource?.disconnect();
  captureProcessor?.disconnect();
  if (captureProcessor) captureProcessor.port.onmessage = null;
  captureSource = captureProcessor = null;
}

async function prepareMicRelay(active) {
  relayWanted = active;
  if (!active || !localStream) { disconnectCapture(); return; }
  const stream = localStream;
  try {
    unlockRoomAudio();
    workletReady ||= soundContext.audioWorklet.addModule("mic-worklet.js");
    await workletReady;
    if (!relayWanted || stream !== localStream || captureProcessor) return;
    captureSource = soundContext.createMediaStreamSource(stream);
    captureProcessor = new AudioWorkletNode(soundContext, "room-microphone");
    captureProcessor.port.onmessage = ({data}) => {
      if (localStream !== stream || !stream.getAudioTracks()[0]?.enabled || ws?.bufferedAmount > 32768) return;
      const pcm = btoa(String.fromCharCode(...new Uint8Array(data)));
      sendRoom({type: "mic-audio", pcm});
    };
    captureSource.connect(captureProcessor);
    // The worklet has silent output. Connecting it keeps processing active.
    captureProcessor.connect(soundContext.destination);
  } catch {
    workletReady = null;
    disconnectCapture();
    appendMessage({system: true, text: "Ses aktarımı başlatılamadı. Tarayıcıdan mikrofonu kapatıp yeniden aç."});
  }
}

function disconnectDirectMixer(id) {
  const mixer = directMixers.get(id);
  if (!mixer) return;
  mixer.source.disconnect();
  mixer.gain.disconnect();
  directMixers.delete(id);
}

function updateVoiceOutput(id) {
  const route = voiceRoutes.get(id);
  const audio = remoteAudioEls.get(id);
  const volume = peerVolumes.get(id) ?? 1;
  const muted = mutedPeers.has(id);
  const stream = audio?.srcObject;
  const mixDirect = stream && volume !== 1 && !route?.relay && !muted && soundContext?.state === "running";
  let mixer = directMixers.get(id);
  if (mixer && (!mixDirect || mixer.stream !== stream)) {
    disconnectDirectMixer(id);
    mixer = null;
  }
  if (mixDirect && !mixer) {
    const source = soundContext.createMediaStreamSource(stream);
    const gain = soundContext.createGain();
    source.connect(gain);
    gain.connect(soundContext.destination);
    mixer = {stream, source, gain};
    directMixers.set(id, mixer);
  }
  if (mixer) mixer.gain.gain.value = volume;
  if (audio) {
    audio.volume = Math.min(1, volume);
    audio.muted = muted || Boolean(route?.relay) || Boolean(mixer);
  }
  if (route?.gain) route.gain.gain.value = route.relay && !muted ? volume : 0;
}

function remoteMic(id, name, active) {
  if (active) {
    voicePeerNames.set(id, name);
    activeMics.add(id);
    if (!voiceRoutes.has(id)) {
      voiceRoutes.set(id, {relay: true, lastBytes: 0, lastPacket: 0, next: 0});
      sendRoom({type: "mic-subscribe", to: id, active: true});
    }
  } else {
    voiceRoutes.get(id)?.gain?.disconnect();
    voiceRoutes.delete(id);
    activeMics.delete(id);
  }
  updateVoiceOutput(id);
  renderVoiceRoster();
}

async function checkVoiceRoute(id, route) {
  if (route.checking) return;
  route.checking = true;
  try {
    const audio = remoteAudioEls.get(id);
    const pc = peerConnections.get(id);
    const receiver = pc?.getReceivers().find(r => r.track === audio?.srcObject?.getAudioTracks()[0]);
    if (receiver && !audio.paused && !receiver.track.muted) {
      const stats = await receiver.getStats();
      stats.forEach(record => {
        if (record.type === "inbound-rtp" && record.bytesReceived > route.lastBytes) {
          route.lastBytes = record.bytesReceived;
          route.lastPacket = performance.now();
        }
      });
    } else route.lastPacket = 0;
    const needsRelay = !route.lastPacket || performance.now() - route.lastPacket > 2500;
    if (voiceRoutes.get(id) !== route || needsRelay === route.relay) return;
    route.relay = needsRelay;
    updateVoiceOutput(id);
    sendRoom({type: "mic-subscribe", to: id, active: needsRelay});
  } catch { /* Keep the room route if this browser cannot report RTP stats. */ }
  finally { route.checking = false; }
}
setInterval(() => { for (const [id, route] of voiceRoutes) checkVoiceRoute(id, route); }, 900);

function playRoomAudio(id, pcm) {
  const route = voiceRoutes.get(id);
  if (!route?.relay || mutedPeers.has(id) || soundContext?.state !== "running" || pcm.length !== 2136) return;
  let raw;
  try { raw = atob(pcm); } catch { return; }
  if (raw.length !== 1600) return;
  const buffer = soundContext.createBuffer(1, 800, 16000);
  const values = buffer.getChannelData(0);
  for (let i = 0; i < values.length; i++) {
    const sample = raw.charCodeAt(2*i) | (raw.charCodeAt(2*i+1) << 8);
    values[i] = (sample << 16 >> 16) / 32768;
  }
  if (!route.gain) {
    route.gain = soundContext.createGain();
    route.gain.gain.value = peerVolumes.get(id) ?? 1;
    route.gain.connect(soundContext.destination);
  }
  const now = soundContext.currentTime;
  if (route.next > now + 0.30) return;
  const node = soundContext.createBufferSource();
  node.buffer = buffer;
  node.connect(route.gain);
  node.onended = () => node.disconnect();
  const start = Math.max(now + 0.015, route.next);
  node.start(start);
  route.next = start + buffer.duration;
}
