import { useEffect, useRef, useState, type ReactNode } from 'react'

type SpeechRecognitionResultEventLike = Event & {
  readonly resultIndex: number
  readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }> & { readonly isFinal?: boolean }>
}

type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort?(): void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

/** Add browser speech recognition without exposing provider credentials to the page. */
export function VoiceInputButton(input: { readonly isEnabled: () => Promise<boolean>; readonly transcribe: ((audioBase64: string, mimeType: string, language?: string) => Promise<{ readonly ok: boolean; readonly value?: { readonly text: string } }>) | undefined }): ReactNode {
  const [enabled, setEnabled] = useState(true)
  const [listening, setListening] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const recognitionRef = useRef<SpeechRecognitionLike | undefined>(undefined)
  const acceptingResultsRef = useRef(false)
  const seenResultsRef = useRef(new Set<string>())
  const recorderRef = useRef<MediaRecorder | undefined>(undefined)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const captureGenerationRef = useRef(0)
  const capturePendingRef = useRef(false)
  const stoppingRef = useRef(false)
  const mountedRef = useRef(true)
  // The slot re-injects props as fresh closures; keying the effect on the
  // function identity would tear down an active capture mid-recording on an
  // unrelated re-render. The mount is torn down only when the slot unmounts.
  const isEnabledRef = useRef(input.isEnabled)
  isEnabledRef.current = input.isEnabled
  useEffect(() => {
    mountedRef.current = true
    let active = true
    const refresh = (): void => {
      // Background tabs cannot show the composer microphone, so skip the
      // capability round-trip until the page is visible again.
      if (globalThis.document?.visibilityState === 'hidden') return
      void isEnabledRef.current().then((value) => { if (active) setEnabled(value) }, () => undefined)
    }
    const onCapabilityChange = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail?.voiceInputEnabled === 'boolean') setEnabled(event.detail.voiceInputEnabled)
      else refresh()
    }
    refresh()
    const timer = globalThis.setInterval(refresh, 5_000)
    globalThis.addEventListener('freecodego:capability-change', onCapabilityChange)
    return () => {
      active = false
      mountedRef.current = false
      captureGenerationRef.current += 1
      capturePendingRef.current = false
      endRecognition(recognitionRef, acceptingResultsRef, setListening)
      stopRecorder(recorderRef, streamRef)
      globalThis.clearInterval(timer)
      globalThis.removeEventListener('freecodego:capability-change', onCapabilityChange)
    }
  }, [])
  // Losing the capability mid-recording must not leave a hidden microphone
  // running (or insert transcribed text afterwards): stop any active capture
  // or recognition as soon as the switch flips off.
  useEffect(() => {
    if (enabled) return
    captureGenerationRef.current += 1
    capturePendingRef.current = false
    if (recorderRef.current !== undefined) {
      stoppingRef.current = true
      stopRecorder(recorderRef, streamRef)
    } else {
      streamRef.current?.getTracks().forEach((track) => { track.stop() })
      streamRef.current = undefined
    }
    endRecognition(recognitionRef, acceptingResultsRef, setListening)
  }, [enabled])
  // A failed transcription used to end in a rejection handler that returned
  // nothing, so the microphone simply stopped and the composer stayed empty:
  // indistinguishable from a button that never worked. Keep the reason on
  // screen briefly instead.
  useEffect(() => {
    if (failure === undefined) return
    const timer = globalThis.setTimeout(() => { setFailure(undefined) }, 6_000)
    return () => { globalThis.clearTimeout(timer) }
  }, [failure])
  if (!enabled) return null
  const begin = (): void => {
    setFailure(undefined)
    if (capturePendingRef.current || recorderRef.current !== undefined || streamRef.current !== undefined || stoppingRef.current) {
      if (recorderRef.current !== undefined) {
        stoppingRef.current = true
        stopRecorder(recorderRef, streamRef)
      } else {
        captureGenerationRef.current += 1
        capturePendingRef.current = false
        streamRef.current?.getTracks().forEach((track) => { track.stop() })
        streamRef.current = undefined
      }
      setListening(false)
      return
    }
    if (listening) { endRecognition(recognitionRef, acceptingResultsRef, setListening); return }
    if (input.transcribe !== undefined && globalThis.navigator?.mediaDevices?.getUserMedia !== undefined && typeof MediaRecorder !== 'undefined') {
      const captureGeneration = ++captureGenerationRef.current
      capturePendingRef.current = true
      setListening(true)
      void globalThis.navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        if (!mountedRef.current || !capturePendingRef.current || captureGeneration !== captureGenerationRef.current) {
          stream.getTracks().forEach((track) => { track.stop() })
          return
        }
        capturePendingRef.current = false
        const chunks: Blob[] = []
        const recorder = new MediaRecorder(stream)
        recorderRef.current = recorder
        streamRef.current = stream
        recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
        recorder.onstop = () => {
          if (recorderRef.current === recorder) recorderRef.current = undefined
          if (streamRef.current === stream) streamRef.current = undefined
          stoppingRef.current = false
          stream.getTracks().forEach((track) => { track.stop() })
          if (!mountedRef.current || captureGeneration !== captureGenerationRef.current) return
          setListening(false)
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          void blob.arrayBuffer()
            .then(buffer => input.transcribe!(uint8Base64(new Uint8Array(buffer)), blob.type || 'audio/webm', voiceLocale() === 'zh' ? 'zh' : 'en'))
            .then((result) => {
              if (!mountedRef.current || captureGeneration !== captureGenerationRef.current) return
              if (result.ok && result.value?.text.trim()) { insertComposerText(result.value.text.trim()); return }
              setFailure(result.ok ? voiceEmptyText() : voiceFailedText())
            }, () => {
              if (mountedRef.current && captureGeneration === captureGenerationRef.current) setFailure(voiceFailedText())
            })
        }
        recorder.onerror = () => {
          if (recorderRef.current === recorder) recorderRef.current = undefined
          if (streamRef.current === stream) streamRef.current = undefined
          stoppingRef.current = false
          stream.getTracks().forEach((track) => { track.stop() })
          if (mountedRef.current && captureGeneration === captureGenerationRef.current) setListening(false)
        }
        try { recorder.start() } catch {
          recorderRef.current = undefined
          streamRef.current = undefined
          stream.getTracks().forEach((track) => { track.stop() })
          if (mountedRef.current && captureGeneration === captureGenerationRef.current) setListening(false)
        }
      }, () => {
        capturePendingRef.current = false
        if (mountedRef.current && captureGeneration === captureGenerationRef.current) setListening(false)
      })
      return
    }
    const Constructor = speechRecognitionConstructor()
    if (Constructor === undefined) return
    const recognition = new Constructor()
    recognition.lang = voiceLocale() === 'zh' ? 'zh-CN' : 'en-US'
    recognition.interimResults = false
    recognition.continuous = true
    recognition.onresult = (event) => {
      if (!acceptingResultsRef.current) return
      const text = Array.from(event.results).slice(event.resultIndex).filter(result => result.isFinal !== false).map(result => result[0]?.transcript ?? '').join('').trim()
      const normalized = text.replace(/\s+/g, ' ')
      if (normalized !== '' && !seenResultsRef.current.has(normalized)) {
        seenResultsRef.current.add(normalized)
        insertComposerText(normalized)
      }
    }
    recognition.onerror = () => { acceptingResultsRef.current = false; recognitionRef.current = undefined; setListening(false) }
    recognition.onend = () => { acceptingResultsRef.current = false; recognitionRef.current = undefined; setListening(false) }
    seenResultsRef.current.clear()
    acceptingResultsRef.current = true
    recognitionRef.current = recognition
    setListening(true)
    try { recognition.start() } catch { setListening(false) }
  }
  const labels = voiceLocale() === 'zh'
    ? { start: '语音输入', stop: '结束语音输入' }
    : { start: 'Voice input', stop: 'Stop voice input' }
  const label = listening ? labels.stop : labels.start
  return <span style={{ position: 'relative', display: 'inline-flex' }}>
    <button type="button" aria-label={label} title={label} onClick={begin} style={{ width: 28, height: 28, display: 'inline-grid', placeItems: 'center', border: 0, borderRadius: 'var(--fcg-radius-sm)', background: listening ? 'var(--fcg-bg-active)' : 'transparent', color: listening ? 'var(--fcg-brand)' : 'inherit', cursor: 'pointer' }}>{listening ? <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" /></svg> : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" stroke="currentColor" strokeWidth="1.8" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>}</button>
    {failure === undefined ? null : <span role="alert" style={{ position: 'absolute', zIndex: 30, bottom: 'calc(100% + 6px)', right: 0, width: 188, padding: '6px 9px', border: '1px solid color-mix(in srgb, var(--fcg-danger) 32%, var(--fcg-line))', borderRadius: 'var(--fcg-radius-md)', background: 'var(--fcg-bg-layer-2)', color: 'var(--fcg-danger)', fontSize: 11, lineHeight: 1.4, boxShadow: 'var(--fcg-shadow-2)' }}>{failure}</span>}
  </span>
}

function voiceFailedText(): string {
  return voiceLocale() === 'zh' ? '语音转写失败，请重试。' : 'Transcription failed. Try again.'
}

function voiceEmptyText(): string {
  return voiceLocale() === 'zh' ? '没有识别到语音，请靠近麦克风重试。' : 'No speech detected. Move closer to the microphone and try again.'
}

function voiceLocale(): 'zh' | 'en' {
  return globalThis.document?.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Stop a recorder once and immediately release every capture track. */
function stopRecorder(
  recorderRef: { current: MediaRecorder | undefined },
  streamRef: { current: MediaStream | undefined },
): void {
  const recorder = recorderRef.current
  const stream = streamRef.current
  stream?.getTracks().forEach((track) => { track.stop() })
  try { recorder?.stop() } catch { /* recorder may already have closed */ }
}

function endRecognition(
  recognitionRef: { current: SpeechRecognitionLike | undefined },
  acceptingResultsRef: { current: boolean },
  setListening: (value: boolean) => void,
): void {
  acceptingResultsRef.current = false
  const recognition = recognitionRef.current
  recognitionRef.current = undefined
  if (recognition !== undefined) {
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
    try { if (typeof recognition.abort === 'function') recognition.abort(); else recognition.stop() } catch { /* already closed */ }
  }
  setListening(false)
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  const windowLike = globalThis as typeof globalThis & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor }
  return windowLike.SpeechRecognition ?? windowLike.webkitSpeechRecognition
}

function uint8Base64(value: Uint8Array): string { let binary = ''; for (let offset = 0; offset < value.length; offset += 0x8000) binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000)); return btoa(binary) }

function insertComposerText(text: string): void {
  const editor = globalThis.document?.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')
  if (editor !== undefined && editor !== null) {
    editor.focus()
    const selection = globalThis.getSelection?.()
    if (selection !== undefined && selection !== null && editor.lastChild !== null) {
      selection.removeAllRanges()
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection.addRange(range)
    }
    globalThis.document.execCommand('insertText', false, `${editor.textContent?.trim() ? ' ' : ''}${text}`)
    return
  }
  const textarea = globalThis.document?.querySelector<HTMLTextAreaElement>('textarea')
  if (textarea === undefined || textarea === null) return
  const next = `${textarea.value}${textarea.value.trim() === '' ? '' : ' '}${text}`
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, next)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}
