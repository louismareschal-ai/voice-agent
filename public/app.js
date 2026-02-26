const statusPanel = document.getElementById('statusPanel');
const chat = document.getElementById('chat');
const insights = document.getElementById('insights');
const inputBox = document.getElementById('inputBox');
const sendBtn = document.getElementById('sendBtn');
const recordBtn = document.getElementById('recordBtn');
const speakBtn = document.getElementById('speakBtn');
const modeSelect = document.getElementById('modeSelect');
const paywallPanel = document.getElementById('paywallPanel');
const unlockBtn = document.getElementById('unlockBtn');
const privacyInfo = document.getElementById('privacyInfo');
const deleteSessionBtn = document.getElementById('deleteSessionBtn');
const aiConfigInfo = document.getElementById('aiConfigInfo');
const testAiBtn = document.getElementById('testAiBtn');
const aiProbeInfo = document.getElementById('aiProbeInfo');
const voiceInfo = document.getElementById('voiceInfo');
const voiceCalibrationInfo = document.getElementById('voiceCalibrationInfo');
const apiVoiceSelect = document.getElementById('apiVoiceSelect');
const liveTranscript = document.getElementById('liveTranscript');
const mindStateCard = document.getElementById('mindStateCard');
const moodMeterFill = document.getElementById('moodMeterFill');
const moodLabel = document.getElementById('moodLabel');
const stateConfidence = document.getElementById('stateConfidence');
const voiceCloneFile = document.getElementById('voiceCloneFile');
const recordSampleBtn = document.getElementById('recordSampleBtn');
const useRecordingBtn = document.getElementById('useRecordingBtn');
const uploadVoiceCloneBtn = document.getElementById('uploadVoiceCloneBtn');
const testClonedVoiceBtn = document.getElementById('testClonedVoiceBtn');
const voiceCloneInfo = document.getElementById('voiceCloneInfo');
const recordingInfo = document.getElementById('recordingInfo');
const consentVoiceAdapt = document.getElementById('consentVoiceAdapt');
const consentTwinTraining = document.getElementById('consentTwinTraining');
const consentVoiceClone = document.getElementById('consentVoiceClone');
const saveConsentBtn = document.getElementById('saveConsentBtn');
const consentInfo = document.getElementById('consentInfo');
let retentionTimer = null;
let privacySnapshot = null;

let sessionId = null;
let sessionMode = 'twin';
let sessionConsent = {
  consentVoiceAdapt: false,
  consentTwinTraining: false,
  consentVoiceClone: false,
  updatedAt: null
};
let voiceEnabled = true;
let listening = false;
let recognition = null;
let recognitionShouldStayOn = false;
let recognitionRestartTimer = null;
let recognitionFinalText = '';
let recognitionInterimText = '';
let sendingByVoiceCommand = false;
let suppressRecognitionUntil = 0;
let currentVoiceTurnMeta = null;
let sampleRecorder = null;
let sampleStream = null;
let sampleChunks = [];
let recordedSampleBlob = null;
let availableVoices = [];
let voiceCalibrated = false;
let calibrationInProgress = false;
let voiceProviderState = null;
let selectedApiVoiceId = window.localStorage.getItem('aiMirrorApiVoiceId') || '';
let activeApiAudio = null;
let activeApiAudioUrl = null;
let currentSpokenTextNormalized = '';
let isAssistantOutputPlaying = false;
let voiceProfile = {
  voiceName: '',
  rate: 1,
  pitch: 1
};

function normalizeSpeechText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function setAssistantOutputState(isPlaying, text = '') {
  isAssistantOutputPlaying = isPlaying;
  currentSpokenTextNormalized = isPlaying ? normalizeSpeechText(text) : '';
}

function tokenOverlapScore(a, b) {
  if (!a || !b) return 0;
  const tokensA = new Set(a.split(' ').filter(Boolean));
  const tokensB = new Set(b.split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap += 1;
  }

  return overlap / Math.min(tokensA.size, tokensB.size);
}

function looksLikePlaybackEcho(recognizedText) {
  if (!isAssistantOutputPlaying) return false;

  const normalizedRecognized = normalizeSpeechText(recognizedText);
  if (!normalizedRecognized || normalizedRecognized.length < 8) {
    return false;
  }

  if (currentSpokenTextNormalized.includes(normalizedRecognized)) {
    return true;
  }

  return tokenOverlapScore(normalizedRecognized, currentSpokenTextNormalized) >= 0.72;
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function resetVoiceTurnMeta() {
  currentVoiceTurnMeta = {
    startedAt: 0,
    lastChunkAt: 0,
    pauseCount: 0,
    longPauseCount: 0,
    maxPauseMs: 0,
    finalChunkCount: 0,
    wordCount: 0
  };
}

function ensureVoiceTurnMetaStarted() {
  if (!currentVoiceTurnMeta) {
    resetVoiceTurnMeta();
  }

  if (!currentVoiceTurnMeta.startedAt) {
    currentVoiceTurnMeta.startedAt = Date.now();
  }
}

function trackVoiceChunk(chunk, isFinal) {
  if (!chunk) return;

  ensureVoiceTurnMetaStarted();
  const now = Date.now();

  if (currentVoiceTurnMeta.lastChunkAt > 0) {
    const gapMs = now - currentVoiceTurnMeta.lastChunkAt;
    if (gapMs > 450) {
      currentVoiceTurnMeta.pauseCount += 1;
    }
    if (gapMs > 900) {
      currentVoiceTurnMeta.longPauseCount += 1;
    }
    currentVoiceTurnMeta.maxPauseMs = Math.max(currentVoiceTurnMeta.maxPauseMs, gapMs);
  }

  currentVoiceTurnMeta.lastChunkAt = now;

  if (isFinal) {
    currentVoiceTurnMeta.finalChunkCount += 1;
    const words = chunk.split(/\s+/).filter(Boolean).length;
    currentVoiceTurnMeta.wordCount += words;
  }
}

function buildVoiceSpeechMetaForSend(channel, text) {
  if (channel !== 'voice' || !currentVoiceTurnMeta || !currentVoiceTurnMeta.startedAt) {
    return null;
  }

  const durationMs = Math.max(200, Date.now() - currentVoiceTurnMeta.startedAt);
  const fallbackWords = text.split(/\s+/).filter(Boolean).length;
  const wordCount = Math.max(currentVoiceTurnMeta.wordCount, fallbackWords);
  const speakingRateWpm = wordCount > 0
    ? Number(((wordCount / durationMs) * 60000).toFixed(1))
    : undefined;

  return {
    durationMs,
    wordCount,
    speakingRateWpm,
    pauseCount: currentVoiceTurnMeta.pauseCount,
    longPauseCount: currentVoiceTurnMeta.longPauseCount,
    maxPauseMs: currentVoiceTurnMeta.maxPauseMs,
    finalChunkCount: currentVoiceTurnMeta.finalChunkCount
  };
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function stopSpeakingOutput() {
  if (activeApiAudio) {
    activeApiAudio.pause();
    activeApiAudio.src = '';
    activeApiAudio = null;
  }

  if (activeApiAudioUrl) {
    URL.revokeObjectURL(activeApiAudioUrl);
    activeApiAudioUrl = null;
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }

  setAssistantOutputState(false);
}

function mergeRecognitionText(nextChunk) {
  if (!nextChunk) return recognitionFinalText;
  return [recognitionFinalText, nextChunk].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function syncRecognitionTextToInput() {
  const merged = [recognitionFinalText, recognitionInterimText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  inputBox.value = merged;
  if (liveTranscript) {
    liveTranscript.textContent = merged || 'Listening...';
  }
}

function clearRecognitionBuffer() {
  recognitionFinalText = '';
  recognitionInterimText = '';
  resetVoiceTurnMeta();
  inputBox.value = '';
  if (liveTranscript) {
    liveTranscript.textContent = 'Listening...';
  }
}

function suppressStaleRecognition(ms = 1200) {
  suppressRecognitionUntil = Date.now() + ms;
}

function isRecognitionSuppressed() {
  return Date.now() < suppressRecognitionUntil;
}

function flushRecognitionAfterSend() {
  clearRecognitionBuffer();
  suppressStaleRecognition();

  if (recognition && recognitionShouldStayOn) {
    try {
      recognition.stop();
    } catch (_error) {
      // no-op
    }
  }
}

function parseVoiceSendCommand(textChunk) {
  const trimmed = (textChunk || '').trim();
  if (!trimmed) {
    return { cleanedText: '', shouldSend: false };
  }

  const match = trimmed.match(/^(.*?)(?:\s+)?(?:ok|okay)?\s*send(?:\s+(?:it|this|now))?[.!?]*$/i);
  if (!match) {
    return { cleanedText: trimmed, shouldSend: false };
  }

  return {
    cleanedText: (match[1] || '').trim(),
    shouldSend: true
  };
}

function setListeningUi(isListening) {
  listening = isListening;
  recordBtn.textContent = isListening ? '⏹ Stop Voice' : '🎙 Start Voice';
}

function speak(text) {
  if (!voiceEnabled) return;

  stopSpeakingOutput();
  setAssistantOutputState(true, text);

  if (voiceProviderState?.activeProvider && voiceProviderState.activeProvider !== 'browser' && voiceProviderState?.providerReady) {
    playApiVoice(text);
    return;
  }

  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  const selectedVoice = availableVoices.find((voice) => voice.name === voiceProfile.voiceName);
  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }
  utterance.rate = voiceProfile.rate;
  utterance.pitch = voiceProfile.pitch;
  utterance.onend = () => setAssistantOutputState(false);
  utterance.onerror = () => setAssistantOutputState(false);
  window.speechSynthesis.speak(utterance);
}

async function playApiVoice(text) {
  try {
    const response = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text, voiceId: selectedApiVoiceId || undefined })
    });

    if (!response.ok) {
      const payload = await parseJsonSafe(response);
      throw new Error(payload?.hint || payload?.error || 'API voice playback failed');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    activeApiAudio = audio;
    activeApiAudioUrl = url;
    setAssistantOutputState(true, text);
    audio.onended = () => {
      if (activeApiAudioUrl === url) {
        URL.revokeObjectURL(url);
        activeApiAudioUrl = null;
      }
      if (activeApiAudio === audio) {
        activeApiAudio = null;
      }
      setAssistantOutputState(false);
    };
    audio.onerror = () => {
      if (activeApiAudioUrl === url) {
        URL.revokeObjectURL(url);
        activeApiAudioUrl = null;
      }
      if (activeApiAudio === audio) {
        activeApiAudio = null;
      }
      setAssistantOutputState(false);
    };
    await audio.play();
  } catch (_error) {
    setAssistantOutputState(false);
    if (window.speechSynthesis) {
      const fallback = new SpeechSynthesisUtterance(text);
      setAssistantOutputState(true, text);
      fallback.onend = () => setAssistantOutputState(false);
      fallback.onerror = () => setAssistantOutputState(false);
      window.speechSynthesis.speak(fallback);
    }
  }
}

function stopSampleRecorderTracks() {
  if (sampleStream) {
    sampleStream.getTracks().forEach((track) => track.stop());
    sampleStream = null;
  }
}

async function startSampleRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    recordingInfo.textContent = 'In-app recording is not supported in this browser.';
    return;
  }

  try {
    sampleStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    sampleChunks = [];
    const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? { mimeType: 'audio/webm;codecs=opus' }
      : undefined;

    sampleRecorder = new MediaRecorder(sampleStream, options);
    sampleRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        sampleChunks.push(event.data);
      }
    };

    sampleRecorder.onstop = () => {
      if (sampleChunks.length > 0) {
        const mimeType = sampleRecorder.mimeType || 'audio/webm';
        recordedSampleBlob = new Blob(sampleChunks, { type: mimeType });
        useRecordingBtn.disabled = false;
        recordingInfo.textContent = `Recording captured (${Math.round(recordedSampleBlob.size / 1024)} KB). Click "Use Last Recording" to upload.`;
      } else {
        recordingInfo.textContent = 'Recording ended but no audio was captured.';
      }

      stopSampleRecorderTracks();
      sampleRecorder = null;
      sampleChunks = [];
      recordSampleBtn.textContent = '⏺ Start Sample Recording';
    };

    sampleRecorder.start();
    recordSampleBtn.textContent = '⏹ Stop Sample Recording';
    recordingInfo.textContent = 'Recording... speak naturally for 20-60 seconds.';
  } catch (_error) {
    recordingInfo.textContent = 'Could not start recording. Check microphone permissions.';
    stopSampleRecorderTracks();
    sampleRecorder = null;
  }
}

function stopSampleRecording() {
  if (sampleRecorder && sampleRecorder.state !== 'inactive') {
    sampleRecorder.stop();
  }
}

function renderVoiceProviderState(voice) {
  voiceProviderState = voice || null;
  if (!voiceProviderState) {
    voiceCloneInfo.textContent = 'No voice provider state available.';
    uploadVoiceCloneBtn.disabled = true;
    testClonedVoiceBtn.disabled = true;
    return;
  }

  const lines = [
    `Voice provider: ${voiceProviderState.activeProvider}`,
    `Provider ready: ${voiceProviderState.providerReady ? 'yes' : 'no'}`,
    `Cloned profile: ${voiceProviderState.clonedVoiceAvailable ? 'available' : 'not available'}`
  ];

  if (selectedApiVoiceId) {
    lines.push(`Selected API voice: ${selectedApiVoiceId}`);
  }

  if (voiceProviderState.voiceProfile?.voiceId) {
    lines.push(`Voice ID: ${voiceProviderState.voiceProfile.voiceId}`);
  }

  voiceCloneInfo.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');
  uploadVoiceCloneBtn.disabled = !voiceProviderState.providerReady;
  testClonedVoiceBtn.disabled = !voiceProviderState.clonedVoiceAvailable;
}

function persistVoiceProfile() {
  window.localStorage.setItem('aiMirrorVoiceProfile', JSON.stringify(voiceProfile));
}

function loadVoiceProfile() {
  try {
    const stored = window.localStorage.getItem('aiMirrorVoiceProfile');
    if (!stored) return;
    const parsed = JSON.parse(stored);
    voiceProfile = {
      ...voiceProfile,
      ...parsed
    };
  } catch (_error) {
    // no-op
  }
}

function populateVoices() {
  if (!window.speechSynthesis) {
    voiceInfo.textContent = 'Browser speech synthesis not available.';
    return;
  }

  availableVoices = window.speechSynthesis.getVoices();
  if (availableVoices.length === 0) {
    voiceInfo.textContent = 'No voices available yet. Browser may still be loading them.';
    return;
  }

  if (!voiceProfile.voiceName || !availableVoices.some((voice) => voice.name === voiceProfile.voiceName)) {
    const englishVoice = availableVoices.find((voice) => voice.lang.toLowerCase().startsWith('en'));
    voiceProfile.voiceName = (englishVoice || availableVoices[0]).name;
  }

  persistVoiceProfile();
  voiceInfo.textContent = `Loaded ${availableVoices.length} browser voice(s). Automatic adaptation active when consent is granted.`;
}

function renderApiVoiceOptions(payload) {
  if (!apiVoiceSelect) return;

  const voices = Array.isArray(payload?.voices) ? payload.voices : [];
  const defaultVoiceId = payload?.defaultVoiceId || '';

  if (voices.length === 0) {
    apiVoiceSelect.innerHTML = '<option value="">Default API voice</option>';
    apiVoiceSelect.disabled = true;
    if (!selectedApiVoiceId && defaultVoiceId) {
      selectedApiVoiceId = defaultVoiceId;
      window.localStorage.setItem('aiMirrorApiVoiceId', selectedApiVoiceId);
    }
    return;
  }

  apiVoiceSelect.innerHTML = voices
    .map((voice) => `<option value="${voice.id}">${voice.label}</option>`)
    .join('');

  const exists = voices.some((voice) => voice.id === selectedApiVoiceId);
  if (!exists) {
    selectedApiVoiceId = defaultVoiceId && voices.some((voice) => voice.id === defaultVoiceId)
      ? defaultVoiceId
      : voices[0].id;
  }

  apiVoiceSelect.value = selectedApiVoiceId;
  apiVoiceSelect.disabled = false;
  window.localStorage.setItem('aiMirrorApiVoiceId', selectedApiVoiceId);
}

async function refreshApiVoiceOptions() {
  const response = await fetch('/api/voice-options');
  const payload = await parseJsonSafe(response);

  if (!response.ok || !payload) {
    if (apiVoiceSelect) {
      apiVoiceSelect.innerHTML = '<option value="">Default API voice</option>';
      apiVoiceSelect.disabled = true;
    }
    return;
  }

  renderApiVoiceOptions(payload);
}

function adaptVoiceFromUserState(userState) {
  if (!userState || !sessionConsent.consentVoiceAdapt) return;

  let targetRate = 1;
  let targetPitch = 1;
  const tone = String(userState.tonePreference || '').toLowerCase();
  const emotion = String(userState.emotionalState || '').toLowerCase();

  if (tone.includes('direct') || tone.includes('intense')) targetRate += 0.08;
  if (tone.includes('calm') || tone.includes('soft')) targetRate -= 0.07;
  if (emotion.includes('anx') || emotion.includes('stress')) targetRate -= 0.05;
  if (emotion.includes('excited') || emotion.includes('energ')) targetRate += 0.05;

  if (tone.includes('soft')) targetPitch += 0.06;
  if (tone.includes('deep') || tone.includes('grounded')) targetPitch -= 0.06;

  voiceProfile.rate = Math.max(0.78, Math.min(1.32, Number(targetRate.toFixed(2))));
  voiceProfile.pitch = Math.max(0.78, Math.min(1.28, Number(targetPitch.toFixed(2))));
  persistVoiceProfile();
}

function detectPitchHz(buffer, sampleRate) {
  const size = buffer.length;
  let bestOffset = -1;
  let bestCorrelation = 0;
  let rms = 0;

  for (let i = 0; i < size; i += 1) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) return null;

  const minLag = Math.floor(sampleRate / 300);
  const maxLag = Math.floor(sampleRate / 80);

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    for (let i = 0; i < size - lag; i += 1) {
      correlation += buffer[i] * buffer[i + lag];
    }
    correlation /= size - lag;

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = lag;
    }
  }

  if (bestOffset <= 0 || bestCorrelation < 0.01) return null;
  return sampleRate / bestOffset;
}

async function calibrateVoiceFromFirstAudio() {
  if (voiceCalibrated || calibrationInProgress || !sessionConsent.consentVoiceAdapt) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    voiceCalibrationInfo.textContent = 'Automatic calibration unavailable in this browser.';
    return;
  }

  calibrationInProgress = true;
  voiceCalibrationInfo.textContent = 'Calibrating from your voice sample...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      voiceCalibrationInfo.textContent = 'Audio calibration unavailable: missing AudioContext.';
      stream.getTracks().forEach((track) => track.stop());
      calibrationInProgress = false;
      return;
    }

    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const samples = [];
    const sampleBuffer = new Float32Array(analyser.fftSize);
    const startedAt = Date.now();

    while (Date.now() - startedAt < 5000) {
      analyser.getFloatTimeDomainData(sampleBuffer);
      const pitchHz = detectPitchHz(sampleBuffer, context.sampleRate);
      if (pitchHz && pitchHz > 80 && pitchHz < 300) {
        samples.push(pitchHz);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }

    stream.getTracks().forEach((track) => track.stop());
    await context.close();

    if (samples.length === 0) {
      voiceCalibrationInfo.textContent = 'Calibration could not detect stable pitch yet. Keep speaking naturally and retry.';
      calibrationInProgress = false;
      return;
    }

    const avgPitchHz = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const normalizedPitch = avgPitchHz < 130 ? 0.9 : avgPitchHz > 190 ? 1.1 : 1.0;
    voiceProfile.pitch = Number(normalizedPitch.toFixed(2));
    voiceProfile.rate = avgPitchHz < 130 ? 0.95 : avgPitchHz > 190 ? 1.05 : 1.0;
    persistVoiceProfile();

    voiceCalibrated = true;
    voiceCalibrationInfo.textContent = `Calibration complete. Estimated base frequency: ${Math.round(avgPitchHz)} Hz. Voice now auto-adapts from your speech style.`;
  } catch (_error) {
    voiceCalibrationInfo.textContent = 'Calibration failed due to microphone permissions or browser policy.';
  }

  calibrationInProgress = false;
}

function setStatus(text) {
  statusPanel.textContent = text;
}

function setStatusLines(lines) {
  statusPanel.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');
}

function renderAiConfigInfo(health) {
  aiConfigInfo.innerHTML = [
    `Provider: ${health.aiProvider}`,
    `Enabled: ${health.aiEnabled ? 'yes' : 'no'}`,
    `Chat model: ${health.aiModelChat}`,
    `Memory model: ${health.aiModelMemory}`,
    `Reason: ${health.aiReason}`
  ]
    .map((line) => `<div>${line}</div>`)
    .join('');
}

function formatTimeRemaining(expiresAt) {
  if (!expiresAt) return 'unknown';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function renderRetention(privacy, expiresAt) {
  const remaining = formatTimeRemaining(expiresAt);
  privacyInfo.innerHTML = [
    `Storage: ${privacy.storage}`,
    `Strict privacy: ${privacy.strictPrivacy ? 'yes' : 'no'}`,
    `Message text in logs: ${privacy.logsContainMessageText ? 'yes' : 'no'}`,
    `Session auto-delete: ${privacy.sessionTtlMinutes} min`,
    `Time to auto-delete: ${remaining}`
  ]
    .map((line) => `<div>${line}</div>`)
    .join('');
}

function startRetentionTicker(privacy, expiresAt) {
  if (retentionTimer) {
    window.clearInterval(retentionTimer);
  }

  renderRetention(privacy, expiresAt);
  retentionTimer = window.setInterval(() => {
    renderRetention(privacy, expiresAt);
  }, 1000);
}

function renderProbeResult(payload) {
  if (!payload) {
    aiProbeInfo.textContent = 'No probe result yet.';
    return;
  }

  const lines = payload.ok
    ? [
      `Probe: OK`,
      `Provider: ${payload.provider}`,
      `Model: ${payload.model}`,
      `Output: ${payload.output || '(empty)'}`
    ]
    : [
      `Probe: FAILED`,
      `Error: ${payload.error || 'Unknown error'}`,
      `Hint: ${payload.hint || 'No hint available'}`
    ];

  aiProbeInfo.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function renderConsent(consent) {
  const current = consent || sessionConsent;
  consentVoiceAdapt.checked = Boolean(current.consentVoiceAdapt);
  consentTwinTraining.checked = Boolean(current.consentTwinTraining);
  consentVoiceClone.checked = Boolean(current.consentVoiceClone);
  const updatedAt = current.updatedAt ? new Date(current.updatedAt).toLocaleString() : 'never';
  consentInfo.innerHTML = [
    `Voice adaptation consent: ${current.consentVoiceAdapt ? 'granted' : 'not granted'}`,
    `Twin training consent: ${current.consentTwinTraining ? 'granted' : 'not granted'}`,
    `Voice clone consent: ${current.consentVoiceClone ? 'granted' : 'not granted'}`,
    `Last updated: ${updatedAt}`
  ].map((line) => `<div>${line}</div>`).join('');
}

function renderProfile(profile) {
  const renderGroup = (title, values) => {
    const chips = (values || []).length > 0
      ? values.map((value) => `<span class="memory-chip">${value}</span>`).join('')
      : '<span class="memory-chip">None yet</span>';

    return [
      '<div class="memory-group">',
      `<div class="memory-title">${title}</div>`,
      `<div class="memory-chip-wrap">${chips}</div>`,
      '</div>'
    ].join('');
  };

  insights.innerHTML = [
    renderGroup('Strengths', profile?.strengths),
    renderGroup('Blockers', profile?.blockers),
    renderGroup('Values', profile?.values),
    renderGroup('Next Actions', profile?.nextActions)
  ].join('');
}

function estimateMoodScore(userState) {
  const emotion = String(userState?.emotionalState || '').toLowerCase();
  const tone = String(userState?.tonePreference || '').toLowerCase();
  let score = 50;

  if (emotion.includes('happy') || emotion.includes('excited') || emotion.includes('energ')) score += 25;
  if (emotion.includes('calm') || emotion.includes('focused')) score += 10;
  if (emotion.includes('stress') || emotion.includes('anx') || emotion.includes('overwhelm')) score -= 20;
  if (emotion.includes('sad') || emotion.includes('frustr')) score -= 18;
  if (tone.includes('direct') || tone.includes('intense')) score += 6;
  if (tone.includes('soft') || tone.includes('neutral')) score += 2;

  return Math.max(0, Math.min(100, score));
}

function renderUserStateViz(userState) {
  if (!mindStateCard || !moodMeterFill || !moodLabel || !stateConfidence) {
    return;
  }

  const score = estimateMoodScore(userState || {});
  const confidence = Math.round((Number(userState?.confidence) || 0) * 100);
  const emotionalState = userState?.emotionalState || 'unclear';
  const goal = userState?.goal || 'unknown';
  const phase = userState?.phase || 'discovery';

  moodMeterFill.style.width = `${score}%`;
  moodLabel.textContent = score >= 65 ? 'Positive drive' : score >= 40 ? 'Neutral/processing' : 'Under pressure';
  stateConfidence.textContent = `${confidence}% confidence`;

  mindStateCard.innerHTML = [
    `<div>Emotion: ${emotionalState}</div>`,
    `<div>Phase: ${phase}</div>`,
    `<div>Goal: ${goal}</div>`
  ].join('');
}

async function initSession() {
  const [sessionResponse, healthResponse, readinessResponse, privacyResponse] = await Promise.all([
    fetch('/api/session', { method: 'POST' }),
    fetch('/api/health'),
    fetch('/api/demo-readiness'),
    fetch('/api/privacy-proof')
  ]);

  const data = await sessionResponse.json();
  let health = await healthResponse.json();
  const readiness = await readinessResponse.json();
  const privacy = await privacyResponse.json();
  privacySnapshot = privacy;

  if (health.aiProvider !== 'openrouter') {
    await fetch('/api/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter',
        modelChat: 'openai/gpt-5',
        modelMemory: 'openai/gpt-4.1-mini',
        probe: false
      })
    });

    health = await fetch('/api/health').then((response) => response.json());
  }

  sessionId = data.sessionId;
  sessionMode = data.sessionMode || 'twin';
  sessionConsent = data.consent || sessionConsent;
  renderVoiceProviderState(data.voice);
  setStatusLines([
    `Free tier: ${data.freeMessages} messages • Used: ${data.messageCount}`,
    `AI mode: ${health.aiEnabled ? `Live (${health.aiProvider})` : 'Fallback demo mode'}`,
    `Sessions in memory: ${readiness.checks.sessionsInMemory}`
  ]);

  modeSelect.value = sessionMode;
  renderAiConfigInfo(health);
  await refreshApiVoiceOptions();
  renderConsent(sessionConsent);
  renderProfile(data.profile);
  renderUserStateViz(data.userState);
  startRetentionTicker(privacy, data.expiresAt);
  addMessage('ai', sessionMode === 'twin'
    ? 'I am your AI twin. I mirror you, challenge you, and push one decisive next move. In 6 months, who are we becoming, and what are you avoiding right now?'
    : 'I am your mirror coach. Short and actionable. What is the first change you want this week?');
}

async function sendCurrentMessage(channel = 'text') {
  const text = inputBox.value.trim();
  if (!text || !sessionId) return;

  const speechMeta = buildVoiceSpeechMetaForSend(channel, text);
  flushRecognitionAfterSend();
  addMessage('user', text);
  sendBtn.disabled = true;

  const startedAt = performance.now();
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, text, channel, speechMeta })
  });

  sendBtn.disabled = false;

  if (response.status === 402) {
    paywallPanel.hidden = false;
    setStatus('Free tier reached. Upgrade required for more conversations.');
    return;
  }

  if (!response.ok) {
    const errorPayload = await parseJsonSafe(response);
    const detail = errorPayload?.details || errorPayload?.error || 'Temporary issue';
    const hint = errorPayload?.hint ? ` Hint: ${errorPayload.hint}` : '';
    addMessage('ai', `I had an issue: ${detail}.${hint}`);
    return;
  }

  const data = await response.json();
  const latencyMs = Math.round(performance.now() - startedAt);
  setStatus(`Free tier: ${data.freeMessages} messages • Used: ${data.messageCount} • Latency: ${latencyMs}ms`);
  if (privacySnapshot) {
    startRetentionTicker(privacySnapshot, data.expiresAt);
  }
  sessionMode = data.sessionMode || sessionMode;
  sessionConsent = data.consent || sessionConsent;
  renderVoiceProviderState(data.voice);
  modeSelect.value = sessionMode;
  renderConsent(sessionConsent);
  adaptVoiceFromUserState(data.userState);
  renderUserStateViz(data.userState);
  renderProfile(data.profile);
  addMessage('ai', data.answer);
  speak(data.answer);
}

async function sendCurrentMessageFromVoiceCommand() {
  if (sendingByVoiceCommand || sendBtn.disabled) return;
  if (!inputBox.value.trim()) return;

  sendingByVoiceCommand = true;
  try {
    await sendCurrentMessage('voice');
    flushRecognitionAfterSend();
  } finally {
    sendingByVoiceCommand = false;
  }
}

function toggleVoiceRecognition() {
  if (!SpeechRecognition) {
    alert('Speech recognition is not supported in this browser. Use Chrome-based browser.');
    return;
  }

  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = async (event) => {
      if (isRecognitionSuppressed()) {
        return;
      }

      const eventChunks = [];

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const rawChunk = event.results[i][0].transcript;
        const chunk = rawChunk.replace(/\s+/g, ' ').trim();
        if (chunk) {
          eventChunks.push(chunk);
        }
      }

      if (looksLikePlaybackEcho(eventChunks.join(' '))) {
        return;
      }

      stopSpeakingOutput();
      let shouldSend = false;
      let interim = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const rawChunk = event.results[i][0].transcript;
        const chunk = rawChunk.replace(/\s+/g, ' ').trim();
        if (!chunk) continue;

        trackVoiceChunk(chunk, event.results[i].isFinal);

        if (event.results[i].isFinal) {
          const parsed = parseVoiceSendCommand(chunk);
          recognitionFinalText = mergeRecognitionText(parsed.cleanedText);
          if (parsed.shouldSend) {
            shouldSend = true;
          }
        } else {
          const interimParsed = parseVoiceSendCommand(chunk);
          interim = [interim, interimParsed.cleanedText].filter(Boolean).join(' ');
        }
      }

      recognitionInterimText = interim.trim();
      syncRecognitionTextToInput();

      if (shouldSend) {
        await sendCurrentMessageFromVoiceCommand();
      }
    };

    recognition.onerror = (_event) => {
      // Let onend manage auto-restart for natural hands-free flow.
    };

    recognition.onend = () => {
      if (!recognitionShouldStayOn) {
        setListeningUi(false);
        return;
      }

      recognitionRestartTimer = window.setTimeout(() => {
        if (!recognitionShouldStayOn) {
          setListeningUi(false);
          return;
        }

        try {
          recognition.start();
          setListeningUi(true);
        } catch (_error) {
          setListeningUi(false);
        }
      }, 250);
    };
  }

  if (recognitionShouldStayOn) {
    recognitionShouldStayOn = false;
    if (recognitionRestartTimer) {
      window.clearTimeout(recognitionRestartTimer);
      recognitionRestartTimer = null;
    }
    recognition.stop();
    setListeningUi(false);
    return;
  }

  stopSpeakingOutput();
  recognitionShouldStayOn = true;
  resetVoiceTurnMeta();
  recognition.start();
  setListeningUi(true);
}

sendBtn.addEventListener('click', () => sendCurrentMessage('voice'));
inputBox.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    sendCurrentMessage('voice');
  }
});
recordBtn.addEventListener('click', toggleVoiceRecognition);
modeSelect.addEventListener('change', async () => {
  if (!sessionId) return;

  const mode = modeSelect.value;
  const response = await fetch('/api/session-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, mode })
  });

  if (!response.ok) {
    alert('Could not switch mode right now.');
    modeSelect.value = sessionMode;
    return;
  }

  sessionMode = mode;
  addMessage('ai', sessionMode === 'twin'
    ? 'Twin mode enabled. I will mirror your language style and identity trajectory more aggressively.'
    : 'Coach mode enabled. I will stay more external and guidance-focused.');
});

speakBtn.addEventListener('click', () => {
  voiceEnabled = !voiceEnabled;
  speakBtn.textContent = voiceEnabled ? '🔊 Voice On' : '🔇 Voice Off';
});
unlockBtn.addEventListener('click', () => {
  alert('Demo CTA clicked. Connect this to Stripe checkout in day 2.');
});

deleteSessionBtn.addEventListener('click', async () => {
  if (!sessionId) return;

  const response = await fetch(`/api/session/${sessionId}`, { method: 'DELETE' });
  if (!response.ok) {
    alert('Could not delete session. Try again.');
    return;
  }

  addMessage('ai', 'Your session was deleted. Starting a fresh session now.');
  voiceCalibrated = false;
  voiceCalibrationInfo.textContent = 'Calibration reset for new session.';
  await initSession();
});

testAiBtn.addEventListener('click', async () => {
  testAiBtn.disabled = true;
  const response = await fetch('/api/ai-probe', { method: 'POST' });
  testAiBtn.disabled = false;

  const payload = await parseJsonSafe(response);
  renderProbeResult(payload || { ok: false, error: 'Probe failed without JSON response.' });
});

saveConsentBtn.addEventListener('click', async () => {
  if (!sessionId) return;

  const response = await fetch('/api/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      consentVoiceAdapt: consentVoiceAdapt.checked,
      consentTwinTraining: consentTwinTraining.checked,
      consentVoiceClone: consentVoiceClone.checked
    })
  });

  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload) {
    alert(payload?.error || 'Could not save consent.');
    return;
  }

  sessionConsent = payload.consent;
  renderConsent(sessionConsent);
  renderVoiceProviderState(payload.voice);
  addMessage('ai', 'Consent updated. I will follow these settings in this session.');
});

uploadVoiceCloneBtn.addEventListener('click', async () => {
  if (!sessionId) return;

  if (!voiceProviderState?.providerReady) {
    alert('Voice clone provider is not ready. Add provider key in .env (ELEVENLABS_API_KEY or CARTESIA_API_KEY) and restart npm run demo.');
    return;
  }

  if (!sessionConsent?.consentVoiceClone) {
    alert('Enable voice clone consent first, then save consent.');
    return;
  }

  const file = voiceCloneFile.files?.[0];
  const audioSource = recordedSampleBlob || file;

  if (!audioSource) {
    alert('Record a sample or select an audio file first.');
    return;
  }

  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('label', 'Twin Voice Profile');
  if (recordedSampleBlob) {
    form.append('audio', recordedSampleBlob, 'recorded-sample.webm');
  } else {
    form.append('audio', file);
  }

  uploadVoiceCloneBtn.disabled = true;
  const response = await fetch('/api/voice/clone', {
    method: 'POST',
    body: form
  });
  uploadVoiceCloneBtn.disabled = false;

  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload) {
    alert(payload?.hint || payload?.error || 'Voice clone upload failed.');
    return;
  }

  renderVoiceProviderState(payload.voice);
  addMessage('ai', 'Voice sample uploaded. Cloned voice profile is ready for playback.');
  recordedSampleBlob = null;
  useRecordingBtn.disabled = true;
  recordingInfo.textContent = 'Sample uploaded successfully.';
});

testClonedVoiceBtn.addEventListener('click', async () => {
  await playApiVoice('This is your twin voice speaking.');
});

if (apiVoiceSelect) {
  apiVoiceSelect.addEventListener('change', () => {
    selectedApiVoiceId = apiVoiceSelect.value;
    window.localStorage.setItem('aiMirrorApiVoiceId', selectedApiVoiceId);
    renderVoiceProviderState(voiceProviderState);
  });
}

recordSampleBtn.addEventListener('click', async () => {
  if (sampleRecorder && sampleRecorder.state === 'recording') {
    stopSampleRecording();
    return;
  }

  await startSampleRecording();
});

useRecordingBtn.addEventListener('click', () => {
  if (!recordedSampleBlob) {
    recordingInfo.textContent = 'No recording available yet.';
    return;
  }

  voiceCloneFile.value = '';
  recordingInfo.textContent = 'Using in-app recording for next upload.';
});

loadVoiceProfile();
populateVoices();
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    populateVoices();
  };
}

initSession();

recordBtn.addEventListener('click', async () => {
  if (!listening && sessionConsent.consentVoiceAdapt) {
    await calibrateVoiceFromFirstAudio();
  }
});
