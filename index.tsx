import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

export class GeminiLiveApp {
  private recordingStatus: HTMLElement;
  private unifiedSourceSelect: HTMLSelectElement;
  private languageSelect: HTMLSelectElement;
  private translationSelect: HTMLSelectElement;
  private rawTranscription: HTMLElement;
  private rawInterimDiv: HTMLElement | null = null;
  private translatedContent: HTMLElement;
  private isRecording: boolean = false;
  private interimResult: string = '';
  private isWebSpeechActive: boolean = false;
  private nextStartTime: number = 0;
  private selectedSourceType: string = 'mic';
  private stream: MediaStream | null = null;
  private recognition: any;
  private audioContext: AudioContext | null = null;
  private outputAudioContext: AudioContext | null = null;
  private outputGainNode: GainNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sessionPromise: Promise<any> | null = null;

  constructor() {
    this.recordingStatus = document.getElementById('status') as HTMLElement;
    this.unifiedSourceSelect = document.getElementById('source') as HTMLSelectElement;
    this.languageSelect = document.getElementById('language') as HTMLSelectElement;
    this.translationSelect = document.getElementById('translation') as HTMLSelectElement;
    this.rawTranscription = document.getElementById('transcription') as HTMLElement;
    this.translatedContent = document.getElementById('translation-output') as HTMLElement;
  }

  private async ensureApiKey(): Promise<void> {
    if (!process.env.API_KEY) throw new Error("API Key required");
  }
  
  private ensureInterimContainer(): void {
    if (!this.rawInterimDiv) {
      this.rawInterimDiv = document.createElement('div');
      this.rawTranscription.appendChild(this.rawInterimDiv);
    }
  }

  private appendTranscriptItem(text: string, speaker: string): void {
    const div = document.createElement('div');
    div.textContent = `${speaker}: ${text}`;
    this.rawTranscription.insertBefore(div, this.rawInterimDiv);
  }

  private handleTranslationAndTTS(text: string, lang: string): void {
    console.log(`Translating to ${lang}: ${text}`);
  }

  private updateInterimText(text: string): void {
    if (this.rawInterimDiv) this.rawInterimDiv.textContent = text;
  }

  private startLiveDisplay(): void {
    if (this.recordingStatus) this.recordingStatus.style.color = 'green';
  }

  private handleLiveMessage(message: LiveServerMessage, isTranslationMode: boolean): void {
    console.log('Live message received', message);
  }

  private stopLiveDisplay(): void {
    if (this.recordingStatus) this.recordingStatus.style.color = '';
    this.isRecording = false;
  }

  private async startLiveSession(): Promise<void> {
    try {
      await this.ensureApiKey();
      this.isRecording = true;
      this.recordingStatus.textContent = 'Initializing Live Session...';
      this.interimResult = '';
      this.isWebSpeechActive = false;
      this.nextStartTime = 0;
      
      // Determine Source Type and Device ID from Unified Dropdown
      const sourceValue = this.unifiedSourceSelect.value;
      let deviceId: string | undefined = undefined;

      if (sourceValue === 'system') {
          this.selectedSourceType = 'system';
      } else {
          this.selectedSourceType = 'mic';
          deviceId = sourceValue !== 'default' ? sourceValue : undefined;
      }
      
      // Reset DOM for new session
      this.rawTranscription.innerHTML = '';
      this.rawInterimDiv = null;
      this.ensureInterimContainer();
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
          
          // Verify audio track exists
          if (this.stream.getAudioTracks().length === 0) {
              this.stream.getTracks().forEach(t => t.stop());
              this.stream = null;
              throw new Error("No audio track selected. Did you forget to check 'Share Audio'?");
          }
        } catch (err: any) {
          console.error('System audio denied', err);
          this.isRecording = false;
          // Handle user cancellation gracefully
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
              this.recordingStatus.textContent = 'Selection cancelled.';
          } else {
              this.recordingStatus.textContent = err.message || 'System audio error.';
          }
          // Reset status after a delay
          setTimeout(() => {
              if (!this.isRecording) this.recordingStatus.textContent = 'Ready to stream';
          }, 3000);
          return;
        }
      } else {
        // Microphone
        const constraints: MediaStreamConstraints = {
          audio: {
            deviceId: deviceId ? {exact: deviceId} : undefined,
            channelCount: 1,
            sampleRate: 16000, 
          },
        };
        try {
            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
             console.error('Microphone denied', err);
             this.isRecording = false;
             this.recordingStatus.textContent = 'Microphone permission denied.';
             return;
        }
        
        // --- Web Speech API Setup for Microphone ---
        if (('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
           const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
           this.recognition = new SpeechRecognition();
           this.recognition.continuous = true;
           this.recognition.interimResults = true;
           this.recognition.lang = inputLangCode;
           
           this.recognition.onresult = (event: any) => {
             console.log("WebSpeech Result Received"); // DEBUG
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
               this.appendTranscriptItem(final, 'You');
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
             // Only attempt restart if we originally succeeded in starting and are still recording
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
             this.isWebSpeechActive = true;
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


      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream!);
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

      const client = new GoogleGenAI({ apiKey: process.env.API_KEY });
      this.sessionPromise = client.live.connect({
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
            // 3. OR it is 'mic' source and WebSpeech FAILED (fallback mode).
            // IF 'mic' source AND translating AND WebSpeech active, we DISABLE audio streaming to Live 
            // because Live is just a TTS engine in that case.
            
            const isMicFallback = (this.selectedSourceType === 'mic' && !this.isWebSpeechActive);
            const shouldStreamAudioToGemini = (this.selectedSourceType === 'system') || (!isTranslationMode) || isMicFallback;

            if (shouldStreamAudioToGemini && this.sourceNode && this.processor && this.audioContext) {
                console.log("Streaming Audio to Gemini (System or Fallback)");
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
                                media: {
                                    mimeType: "audio/pcm;rate=16000",
                                    data: base64Audio
                                }
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
}
