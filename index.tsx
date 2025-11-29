
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

import {GoogleGenAI, LiveServerMessage, Modality} from '@google/genai';
import {marked} from 'marked';

const MODEL_NAME = 'gemini-2.5-flash';
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

interface Note {
  id: string;
  rawTranscription: string;
  translatedContent: string;
  timestamp: number;
}

class VoiceNotesApp {
  private genAI: any;
  private recordButton: HTMLButtonElement;
  private recordingStatus: HTMLDivElement;
  private rawTranscription: HTMLDivElement;
  private translatedContent: HTMLDivElement;
  private newButton: HTMLButtonElement;
  private themeToggleButton: HTMLButtonElement;
  private themeToggleIcon: HTMLElement;
  private isRecording = false;
  private currentNote: Note | null = null;
  private stream: MediaStream | null = null;
  private editorTitle: HTMLDivElement;

  private recordingInterface: HTMLDivElement;
  private liveRecordingTitle: HTMLDivElement;
  private liveWaveformCanvas: HTMLCanvasElement | null;
  private liveWaveformCtx: CanvasRenderingContext2D | null = null;
  private liveRecordingTimerDisplay: HTMLDivElement;
  private statusIndicatorDiv: HTMLDivElement | null;

  // Audio Contexts
  private audioContext: AudioContext | null = null; // For Input Processing
  private outputAudioContext: AudioContext | null = null; // For Output Playback (Translation)
  private outputGainNode: GainNode | null = null;
  private nextStartTime: number = 0;
  
  private analyserNode: AnalyserNode | null = null;
  private waveformDataArray: Uint8Array | null = null;
  private waveformDrawingId: number | null = null;
  private timerIntervalId: number | null = null;
  private recordingStartTime: number = 0;

  // Live API specifics
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private sessionPromise: Promise<any> | null = null;
  
  // Transcription State
  private rawInterimSpan: HTMLSpanElement | null = null;

  // Source selection
  private sourceCards: NodeListOf<HTMLDivElement>;
  private deviceSelect: HTMLSelectElement;
  private languageSelect: HTMLSelectElement;
  private translationSelect: HTMLSelectElement;
  private systemAudioInfo: HTMLDivElement;
  private selectedSourceType: 'mic' | 'system' = 'mic';

  // Web Speech API
  private recognition: any | null = null;
  private isWebSpeechActive: boolean = false;
  private interimResult: string = '';

  constructor() {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.recordButton = document.getElementById(
      'recordButton',
    ) as HTMLButtonElement;
    this.recordingStatus = document.getElementById(
      'recordingStatus',
    ) as HTMLDivElement;
    this.rawTranscription = document.getElementById(
      'rawTranscription',
    ) as HTMLDivElement;
    this.translatedContent = document.getElementById(
      'translatedContent',
    ) as HTMLDivElement;
    this.newButton = document.getElementById('newButton') as HTMLButtonElement;
    this.themeToggleButton = document.getElementById(
      'themeToggleButton',
    ) as HTMLButtonElement;
    this.themeToggleIcon = this.themeToggleButton.querySelector(
      'i',
    ) as HTMLElement;
    this.editorTitle = document.querySelector(
      '.editor-title',
    ) as HTMLDivElement;

    this.recordingInterface = document.querySelector(
      '.recording-interface',
    ) as HTMLDivElement;
    this.liveRecordingTitle = document.getElementById(
      'liveRecordingTitle',
    ) as HTMLDivElement;
    this.liveWaveformCanvas = document.getElementById(
      'liveWaveformCanvas',
    ) as HTMLCanvasElement;
    this.liveRecordingTimerDisplay = document.getElementById(
      'liveRecordingTimerDisplay',
    ) as HTMLDivElement;
    this.sourceCards = document.querySelectorAll(
      '.input-card',
    ) as NodeListOf<HTMLDivElement>;
    this.deviceSelect = document.getElementById(
      'audioDeviceSelect',
    ) as HTMLSelectElement;
    this.languageSelect = document.getElementById(
      'languageSelect',
    ) as HTMLSelectElement;
    this.translationSelect = document.getElementById(
      'translationSelect',
    ) as HTMLSelectElement;
    this.systemAudioInfo = document.getElementById(
      'systemAudioInfo',
    ) as HTMLDivElement;

    if (this.liveWaveformCanvas) {
      this.liveWaveformCtx = this.liveWaveformCanvas.getContext('2d');
    }

    if (this.recordingInterface) {
      this.statusIndicatorDiv = this.recordingInterface.querySelector(
        '.status-indicator',
      ) as HTMLDivElement;
    } else {
      this.statusIndicatorDiv = null;
    }

    this.bindEventListeners();
    this.initTheme();
    this.createNewNote();
    this.populateAudioDevices();
  }

  private bindEventListeners(): void {
    this.recordButton.addEventListener('click', () => this.toggleRecording());
    this.newButton.addEventListener('click', () => this.createNewNote());
    this.themeToggleButton.addEventListener('click', () => this.toggleTheme());
    window.addEventListener('resize', this.handleResize.bind(this));

    // Source Selection Logic
    this.sourceCards.forEach((card) => {
      card.addEventListener('click', () => {
        this.sourceCards.forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedSourceType = card.dataset.type as 'mic' | 'system';

        const deviceGroup = document.getElementById('deviceSelectionGroup');
        if (deviceGroup) {
          if (this.selectedSourceType === 'system') {
            deviceGroup.style.opacity = '0.5';
            deviceGroup.style.pointerEvents = 'none';
            if (this.systemAudioInfo) this.systemAudioInfo.style.display = 'block';
          } else {
            deviceGroup.style.opacity = '1';
            deviceGroup.style.pointerEvents = 'auto';
            if (this.systemAudioInfo) this.systemAudioInfo.style.display = 'none';
          }
        }
      });
    });

    // Detect device changes
    navigator.mediaDevices.addEventListener('devicechange', () => {
      this.populateAudioDevices();
    });
  }

  private async populateAudioDevices(): Promise<void> {
    try {
      // Check permissions first to get labels
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(
        (device) => device.kind === 'audioinput',
      );

      // Save current selection if possible
      const currentSelection = this.deviceSelect.value;

      this.deviceSelect.innerHTML = '';

      if (audioInputs.length === 0) {
        const option = document.createElement('option');
        option.text = 'Default Microphone';
        option.value = 'default';
        this.deviceSelect.add(option);
      } else {
        audioInputs.forEach((device) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text =
              device.label || `Microphone ${this.deviceSelect.length + 1}`;
            this.deviceSelect.add(option);
          });
      }

      // Restore selection or select default
      const hasCurrent = Array.from(this.deviceSelect.options).some(
        (opt) => opt.value === currentSelection,
      );
      if (hasCurrent) {
        this.deviceSelect.value = currentSelection;
      }
    } catch (e) {
      console.error('Error enumerating devices:', e);
      // Fallback
      if (this.deviceSelect.options.length === 0) {
         const option = document.createElement('option');
         option.text = 'Default Microphone';
         option.value = 'default';
         this.deviceSelect.add(option);
      }
    }
  }

  private handleResize(): void {
    if (
      this.isRecording &&
      this.liveWaveformCanvas &&
      this.liveWaveformCanvas.style.display === 'block'
    ) {
      requestAnimationFrame(() => {
        this.setupCanvasDimensions();
      });
    }
  }

  private setupCanvasDimensions(): void {
    if (!this.liveWaveformCanvas || !this.liveWaveformCtx) return;

    const canvas = this.liveWaveformCanvas;
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    this.liveWaveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private initTheme(): void {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      document.body.classList.remove('light-mode');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private toggleTheme(): void {
    document.body.classList.toggle('light-mode');
    if (document.body.classList.contains('light-mode')) {
      localStorage.setItem('theme', 'light');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      localStorage.setItem('theme', 'dark');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private async toggleRecording(): Promise<void> {
    if (!this.isRecording) {
      await this.startLiveSession();
    } else {
      await this.stopLiveSession();
    }
  }

  private setupAudioVisualizer(): void {
    if (!this.stream || !this.audioContext) return;
    // Note: Audio context is created in startLiveSession
    if (!this.analyserNode) {
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.75;
    }

    // If sourceNode already exists (from startLiveSession), connect it
    if (this.sourceNode) {
      // Connect source to analyser for visualization
      // We do NOT connect analyser to destination to avoid feedback loop
      this.sourceNode.connect(this.analyserNode);
    }

    const bufferLength = this.analyserNode.frequencyBinCount;
    this.waveformDataArray = new Uint8Array(bufferLength);
  }

  private drawLiveWaveform(): void {
    if (
      !this.analyserNode ||
      !this.waveformDataArray ||
      !this.liveWaveformCtx ||
      !this.liveWaveformCanvas ||
      !this.isRecording
    ) {
      if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
      return;
    }

    this.waveformDrawingId = requestAnimationFrame(() =>
      this.drawLiveWaveform(),
    );
    this.analyserNode.getByteFrequencyData(this.waveformDataArray);

    const ctx = this.liveWaveformCtx;
    const canvas = this.liveWaveformCanvas;

    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const bufferLength = this.analyserNode.frequencyBinCount;
    const numBars = Math.floor(bufferLength * 0.5);

    if (numBars === 0) return;

    const totalBarPlusSpacingWidth = logicalWidth / numBars;
    const barWidth = Math.max(1, Math.floor(totalBarPlusSpacingWidth * 0.7));
    const barSpacing = Math.max(0, Math.floor(totalBarPlusSpacingWidth * 0.3));

    let x = 0;

    const recordingColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-recording')
        .trim() || '#ff3b30';
    ctx.fillStyle = recordingColor;

    for (let i = 0; i < numBars; i++) {
      if (x >= logicalWidth) break;

      const dataIndex = Math.floor(i * (bufferLength / numBars));
      const barHeightNormalized = this.waveformDataArray[dataIndex] / 255.0;
      let barHeight = barHeightNormalized * logicalHeight;

      if (barHeight < 1 && barHeight > 0) barHeight = 1;
      barHeight = Math.round(barHeight);

      const y = Math.round((logicalHeight - barHeight) / 2);

      ctx.fillRect(Math.floor(x), y, barWidth, barHeight);
      x += barWidth + barSpacing;
    }
  }

  private updateLiveTimer(): void {
    if (!this.isRecording || !this.liveRecordingTimerDisplay) return;
    const now = Date.now();
    const elapsedMs = now - this.recordingStartTime;

    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsedMs % 1000) / 10);

    this.liveRecordingTimerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private startLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      return;
    }

    this.recordingInterface.classList.add('is-live');
    this.liveRecordingTitle.style.display = 'block';
    this.liveWaveformCanvas.style.display = 'block';
    this.liveRecordingTimerDisplay.style.display = 'block';

    this.setupCanvasDimensions();

    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'none';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-microphone');
      iconElement.classList.add('fa-stop');
    }

    const currentTitle = this.editorTitle.textContent?.trim();
    const placeholder =
      this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
    this.liveRecordingTitle.textContent =
      currentTitle && currentTitle !== placeholder
        ? currentTitle
        : 'Live Recording';

    this.setupAudioVisualizer();
    this.drawLiveWaveform();

    this.recordingStartTime = Date.now();
    this.updateLiveTimer();
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = window.setInterval(() => this.updateLiveTimer(), 50);

    // Switch to Raw tab automatically to show live transcription
    const rawTabBtn = document.querySelector(
      '.tab-button[data-tab="raw"]',
    ) as HTMLElement;
    if (rawTabBtn) rawTabBtn.click();
  }

  private stopLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      if (this.recordingInterface)
        this.recordingInterface.classList.remove('is-live');
      return;
    }
    this.recordingInterface.classList.remove('is-live');
    this.liveRecordingTitle.style.display = 'none';
    this.liveWaveformCanvas.style.display = 'none';
    this.liveRecordingTimerDisplay.style.display = 'none';

    if (this.statusIndicatorDiv)
      this.statusIndicatorDiv.style.display = 'block';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-stop');
      iconElement.classList.add('fa-microphone');
    }

    if (this.waveformDrawingId) {
      cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
    if (this.liveWaveformCtx && this.liveWaveformCanvas) {
      this.liveWaveformCtx.clearRect(
        0,
        0,
        this.liveWaveformCanvas.width,
        this.liveWaveformCanvas.height,
      );
    }
  }

  /**
   * Appends a finalized segment to the raw transcription container.
   * Wraps it in a span with a unique ID for highlighting.
   */
  private appendRawSegment(text: string): void {
      if (!text || !text.trim()) return;
      
      this.rawTranscription.classList.remove('placeholder-active');
      
      const span = document.createElement('span');
      span.textContent = text + ' ';
      span.className = 'transcript-segment';
      span.dataset.timestamp = Date.now().toString();
      
      // Insert before interim span if it exists
      if (this.rawInterimSpan && this.rawInterimSpan.parentNode === this.rawTranscription) {
          this.rawTranscription.insertBefore(span, this.rawInterimSpan);
      } else {
          this.rawTranscription.appendChild(span);
          // Re-append interim span to keep it at the end
          this.ensureInterimSpan();
      }
      
      this.rawTranscription.scrollTop = this.rawTranscription.scrollHeight;
  }

  /**
   * Updates the interim span with temporary text.
   */
  private updateInterimText(text: string): void {
      this.ensureInterimSpan();
      if (this.rawInterimSpan) {
          this.rawInterimSpan.textContent = text;
          if (text) {
              this.rawTranscription.classList.remove('placeholder-active');
          }
          this.rawTranscription.scrollTop = this.rawTranscription.scrollHeight;
      }
  }

  private ensureInterimSpan(): void {
      if (!this.rawInterimSpan || this.rawInterimSpan.parentNode !== this.rawTranscription) {
          this.rawInterimSpan = document.createElement('span');
          this.rawInterimSpan.className = 'interim';
          this.rawInterimSpan.style.opacity = '0.6';
          this.rawTranscription.appendChild(this.rawInterimSpan);
      }
  }

  /**
   * Highlights the most recent finalized input segment that hasn't been processed yet.
   * Called when Gemini sends translation audio/text.
   */
  private highlightActiveSegment(): void {
      const segments = this.rawTranscription.querySelectorAll('.transcript-segment');
      if (segments.length === 0) return;

      // Find the last segment (simplest heuristic for real-time sequential translation)
      const lastSegment = segments[segments.length - 1] as HTMLElement;
      
      // Remove highlight from others (optional, or keep trail)
      segments.forEach(seg => seg.classList.remove('active-translation'));
      
      // Highlight the active one
      lastSegment.classList.add('active-translation');
      
      // Ensure it's visible
      lastSegment.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /**
   * Appends translated text instantly to the output container.
   */
  private appendTranslatedText(text: string): void {
      if (!text) return;
      
      this.translatedContent.classList.remove('placeholder-active');
      
      // Simple append for instant rendering. 
      const span = document.createElement('span');
      span.innerHTML = marked.parseInline(text); 
      this.translatedContent.appendChild(span);
      // Add a space for readability
      this.translatedContent.appendChild(document.createTextNode(' '));
      
      this.translatedContent.scrollTop = this.translatedContent.scrollHeight;
  }
  
  private escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
  }

  /**
   * High-quality translation using Gemini Flash.
   */
  private async translateTextWithFlash(text: string, targetLanguage: string): Promise<string> {
    try {
      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME, // gemini-2.5-flash
        contents: `Translate the following text to ${targetLanguage}. Return only the translated text, no markdown block quotes, no preamble. Text: "${text}"`,
      });
      return response.text.trim();
    } catch (e) {
      console.error("Translation error:", e);
      return "";
    }
  }

  /**
   * Handles the separate translation and TTS pipeline for Mic input.
   */
  private async handleTranslationAndTTS(text: string, targetLanguageName: string): Promise<void> {
      // 1. Translate with Flash
      const translatedText = await this.translateTextWithFlash(text, targetLanguageName);
      if (!translatedText) return;

      // 2. Render Translation
      this.appendTranslatedText(translatedText);
      this.highlightActiveSegment();

      // 3. Send to Live Session for TTS (Read Aloud)
      if (this.sessionPromise) {
          this.sessionPromise.then(session => {
             // Send text as a user turn for the model to read aloud
             // Note: In TTS-Only mode, the system prompt tells the model to just READ.
             session.send({ parts: [{ text: translatedText }], endOfTurn: true });
          });
      }
  }

  private async startLiveSession(): Promise<void> {
    try {
      this.isRecording = true;
      this.recordingStatus.textContent = 'Initializing Live Session...';
      this.interimResult = '';
      this.isWebSpeechActive = false;
      this.nextStartTime = 0;
      
      // Reset DOM for new session
      this.rawTranscription.innerHTML = '';
      this.rawInterimSpan = null;
      this.ensureInterimSpan();
      this.translatedContent.innerHTML = '';


      // Prepare Language Instructions
      const selectedInputLanguage = this.languageSelect.value;
      const selectedOutputLanguage = this.translationSelect.value;
      
      const selectedOutputOption = this.translationSelect.options[this.translationSelect.selectedIndex];
      const selectedOutputLanguageText = selectedOutputOption ? selectedOutputOption.text : selectedOutputLanguage;
      
      const inputLangCode = selectedInputLanguage === 'auto' ? 'en-US' : selectedInputLanguage;
      
      // Determine System Prompt based on Translation Mode
      const isTranslationMode = selectedOutputLanguage !== 'none' && selectedOutputLanguage !== selectedInputLanguage;
      let systemInstruction = '';
      
      // SYSTEM PROMPT LOGIC
      // 1. Mic Source + Translation:
      //    WebSpeech captures audio. Flash translates text. Live Model is purely a TTS READER.
      if (this.selectedSourceType === 'mic' && isTranslationMode) {
          systemInstruction = `You are a text-to-speech engine. 
          You will receive text in [${selectedOutputLanguageText}]. 
          Your ONLY task is to read it aloud instantly with a warm, highly motivated, faithfully convicted tone in [${selectedOutputLanguageText}].
          Do not translate (it is already translated). 
          Do not comment. 
          Just read the text provided.`;
      
      // 2. System Source + Translation:
      //    Live Model receives Audio. Live Model Must TRANSLATE AND SPEAK.
      } else if (this.selectedSourceType === 'system' && isTranslationMode) {
           systemInstruction = `Your job is to translate the input audio into [${selectedOutputLanguageText}] and natively read aloud in a warm highly motivated, faithfully convicted style of voice and tone. 
           You are not allowed to interact or comment.
           Your only task is to listen, translate, and read aloud the translation.
           Start continuously.`;

      // 3. Transcription / Assistant Mode (No Output Audio):
      } else {
          systemInstruction = `You are a professional transcription assistant. 
          Your task is to listen to the user audio and generate accurate transcriptions.
          Do not hallucinate. If the audio is silent, do not output text.
          IMPORTANT: You must not speak. Output only silence in the audio channel unless you need to clarify something briefly.`;
      }


      // 1. Get Audio Stream
      if (this.selectedSourceType === 'system') {
        // System / Tab Audio
        try {
          this.stream = await navigator.mediaDevices.getDisplayMedia({
            video: true, // Required for audio in some browsers
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
        } catch (err) {
          console.error('System audio denied', err);
          this.isRecording = false;
          this.recordingStatus.textContent = 'System audio permission denied.';
          return;
        }
      } else {
        // Microphone
        const deviceId = this.deviceSelect.value;
        const constraints: MediaStreamConstraints = {
          audio: {
            deviceId: deviceId && deviceId !== 'default' ? {exact: deviceId} : undefined,
            channelCount: 1,
            sampleRate: 16000, 
          },
        };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // --- Web Speech API Setup for Microphone ---
        if (('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
           this.isWebSpeechActive = true;
           const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
           this.recognition = new SpeechRecognition();
           this.recognition.continuous = true;
           this.recognition.interimResults = true;
           this.recognition.lang = inputLangCode;
           
           this.recognition.onresult = (event: any) => {
             let interim = '';
             let final = '';
             for (let i = event.resultIndex; i < event.results.length; ++i) {
               if (event.results[i].isFinal) {
                 final += event.results[i][0].transcript;
               } else {
                 interim += event.results[i][0].transcript;
               }
             }
             
             if (final) {
               this.appendRawSegment(final);
               // Trigger Translation Pipeline if in Translation Mode
               // For Mic: WebSpeech -> Flash -> TTS
               if (this.selectedSourceType === 'mic' && isTranslationMode) {
                   this.handleTranslationAndTTS(final, selectedOutputLanguageText);
               }
             }
             this.updateInterimText(interim);
           };
           
           this.recognition.onerror = (event: any) => {
             console.log("WebSpeech error", event.error);
             if (event.error === 'aborted' || event.error === 'not-allowed') {
                 this.isWebSpeechActive = false;
             }
           };

           this.recognition.onend = () => {
             if (this.isRecording && this.isWebSpeechActive) {
               setTimeout(() => {
                   if (this.isRecording && this.isWebSpeechActive) {
                        try { this.recognition.start(); } catch(e) { 
                            console.log("WebSpeech restart failed", e);
                            this.isWebSpeechActive = false;
                        }
                   }
               }, 100);
             }
           };

           try {
             this.recognition.start();
           } catch (e) {
             console.error("Failed to start WebSpeech", e);
             this.isWebSpeechActive = false; 
           }
        }
      }

      // 2. Setup Input Audio Context (16kHz)
      this.audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({
        sampleRate: 16000, 
      });

      // 3. Setup Output Audio Context (24kHz)
      this.outputAudioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({
        sampleRate: 24000, 
      });
      // Ensure context is running for autoplay
      if (this.outputAudioContext.state === 'suspended') {
          await this.outputAudioContext.resume();
      }
      this.outputGainNode = this.outputAudioContext.createGain();
      this.outputGainNode.connect(this.outputAudioContext.destination);


      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      // 4. Connect to Gemini Live
      const liveConfig = {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Charon'}},
          },
          systemInstruction: systemInstruction,
          // Enable audio transcription to populate tabs in System/Tab Mode
          inputAudioTranscription: {}, 
          outputAudioTranscription: {},
      };

      this.sessionPromise = this.genAI.live.connect({
        model: LIVE_MODEL,
        config: liveConfig,
        callbacks: {
          onopen: () => {
            this.recordingStatus.textContent = 'Live Session Active';
            this.startLiveDisplay();
            
            // --- Audio Pipeline ---
            // Stream audio to Gemini ONLY IF:
            // 1. It is 'system' source (we need live model to hear system audio).
            // 2. OR it is 'mic' source but NOT translating (assistant mode).
            // IF 'mic' source AND translating, we DISABLE audio streaming to Live.
            // Why? Because we use WebSpeech for input, and Live is just a TTS engine for output.
            // Streaming audio would confuse it.
            
            const shouldStreamAudioToGemini = (this.selectedSourceType === 'system') || (!isTranslationMode);

            if (shouldStreamAudioToGemini && this.sourceNode && this.processor && this.audioContext) {
                this.sourceNode.connect(this.processor);
                this.processor.connect(this.audioContext.destination);
                
                this.processor.onaudioprocess = (e) => {
                    const inputData = e.inputBuffer.getChannelData(0);
                    // Convert Float32 to Int16 PCM
                    const pcmData = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
                    }
                    
                    const base64Audio = btoa(
                        String.fromCharCode(...new Uint8Array(pcmData.buffer))
                    );
                    
                    if (this.sessionPromise) {
                        this.sessionPromise.then(session => {
                            session.sendRealtimeInput({
                                mimeType: "audio/pcm;rate=16000",
                                data: base64Audio
                            });
                        });
                    }
                };
            }
          },
          onmessage: (message: LiveServerMessage) => {
            this.handleLiveMessage(message, isTranslationMode);
          },
          onclose: () => {
            console.log('Live session closed');
            this.stopLiveDisplay();
          },
          onerror: (err: any) => {
            console.error('Live session error:', err);
            this.recordingStatus.textContent = 'Connection Error';
            this.stopLiveDisplay();
          },
        },
      });

    } catch (error) {
      console.error('Error starting live session:', error);
      this.isRecording = false;
      this.recordingStatus.textContent = 'Error starting session';
    }
  }

  private async handleLiveMessage(message: LiveServerMessage, isTranslationMode: boolean): Promise<void> {
      // 1. Handle Audio Output (TTS or Translation Audio)
      const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
      if (audioData) {
          if (isTranslationMode && this.selectedSourceType === 'system') {
              // Only highlight for system mode here, as Mic mode highlights on text generation
              this.highlightActiveSegment();
          }
          await this.playAudioChunk(audioData);
      }
      
      // 2. Handle Text (Fallback or System Audio Translation)
      // In Mic Mode, we ignore Gemini's text because we use Flash.
      // In System Mode, we use the input/output transcription from Live API.
      if (this.selectedSourceType === 'system') {
          
          // Handle Input Transcription (Raw Audio Source)
          const inputTranscript = message.serverContent?.inputTranscription?.text;
          if (inputTranscript) {
              this.appendRawSegment(inputTranscript);
          }

          // Handle Output Transcription (Translated Text)
          const outputTranscript = message.serverContent?.outputTranscription?.text;
          if (outputTranscript) {
              this.appendTranslatedText(outputTranscript);
          }
          
          // Fallback: Check modelTurn text if outputTranscription is missing
          if (!outputTranscript) {
              const textPart = message.serverContent?.modelTurn?.parts?.find(p => p.text);
              if (textPart && textPart.text) {
                 this.appendTranslatedText(textPart.text);
              }
          }
      }
  }

  private async playAudioChunk(base64Audio: string): Promise<void> {
      if (!this.outputAudioContext || !this.outputGainNode) return;
      
      try {
          // Decode
          const binaryString = atob(base64Audio);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          
          const audioBuffer = await this.decodeAudioData(bytes, this.outputAudioContext);
          
          // Schedule
          const source = this.outputAudioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(this.outputGainNode);
          
          const currentTime = this.outputAudioContext.currentTime;
          // Ensure we don't schedule in the past
          if (this.nextStartTime < currentTime) {
              this.nextStartTime = currentTime;
          }
          
          source.start(this.nextStartTime);
          this.nextStartTime += audioBuffer.duration;
          
      } catch (e) {
          console.error("Error playing audio chunk", e);
      }
  }

  private async decodeAudioData(data: Uint8Array, ctx: AudioContext): Promise<AudioBuffer> {
    // 24kHz raw PCM decoding
    const dataInt16 = new Int16Array(data.buffer);
    const float32Data = new Float32Array(dataInt16.length);
    
    for (let i = 0; i < dataInt16.length; i++) {
        float32Data[i] = dataInt16[i] / 32768.0;
    }

    const buffer = ctx.createBuffer(1, float32Data.length, 24000);
    buffer.getChannelData(0).set(float32Data);
    return buffer;
  }

  private async stopLiveSession(): Promise<void> {
    this.isRecording = false;
    this.recordingStatus.textContent = 'Stopping...';
    
    // Stop WebSpeech
    if (this.recognition) {
        this.isWebSpeechActive = false; 
        try { this.recognition.stop(); } catch(e) {}
    }

    // Stop Gemini Live
    if (this.sessionPromise) {
        // Unfortunately no direct close method on the promise wrapper in this SDK version structure
        // But usually we just let it drift or if there is a close method on the resolved session
        // We will just assume disconnection logic is handled by dropping refs
    }

    // Stop Audio Contexts
    if (this.processor) {
        this.processor.disconnect();
        this.processor.onaudioprocess = null;
        this.processor = null;
    }
    if (this.sourceNode) {
        this.sourceNode.disconnect();
        this.sourceNode = null;
    }
    if (this.stream) {
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
    }
    
    // We don't close AudioContexts entirely as we might reuse them, but we can suspend
    if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
        this.audioContext = null;
    }
    if (this.outputAudioContext) {
        // Keep output open or close? Better to close and recreate to reset timing
        await this.outputAudioContext.close();
        this.outputAudioContext = null;
    }

    this.stopLiveDisplay();
    this.recordingStatus.textContent = 'Session Ended';
  }

  // --- Helper Methods ---

  private createNewNote(): void {
    const noteId = Date.now().toString();
    this.currentNote = {
      id: noteId,
      rawTranscription: '',
      translatedContent: '',
      timestamp: Date.now(),
    };
    
    this.rawTranscription.innerHTML = '';
    this.rawInterimSpan = null;
    this.ensureInterimSpan();
    this.translatedContent.innerHTML = '';
    
    this.editorTitle.textContent = '';
    this.editorTitle.focus();
  }
}

new VoiceNotesApp();
