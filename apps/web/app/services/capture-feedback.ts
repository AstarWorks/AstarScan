/**
 * Capture-moment helpers for the live ✓ feedback: a full-resolution still
 * from the camera (ImageCapture.takePhoto), a short vibration and a short
 * beep. Every helper degrades silently where the platform lacks the API
 * (iOS Safari has no ImageCapture and no navigator.vibrate).
 */

interface PhotoCapabilitiesLike {
  imageWidth?: { max?: number }
  imageHeight?: { max?: number }
}

interface ImageCaptureLike {
  takePhoto(settings?: {
    imageWidth?: number
    imageHeight?: number
  }): Promise<Blob>
  getPhotoCapabilities?(): Promise<PhotoCapabilitiesLike>
}

type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike

export interface StillCapturer {
  /** Full-resolution still, or null when the camera refused. */
  take(): Promise<Blob | null>
}

/**
 * Bind a still capturer to a live video track. Returns null when the
 * platform has no ImageCapture — callers fall back to the video frame.
 */
export function createStillCapturer(
  track: MediaStreamTrack | undefined,
): StillCapturer | null {
  const Ctor = (globalThis as unknown as { ImageCapture?: ImageCaptureCtor })
    .ImageCapture
  if (!Ctor || !track || track.readyState !== 'live') return null
  let ic: ImageCaptureLike
  try {
    ic = new Ctor(track)
  } catch {
    return null
  }
  // Max resolution is looked up once; takePhoto without settings uses the
  // device default, which is not always the maximum.
  const caps: Promise<PhotoCapabilitiesLike | null> = ic.getPhotoCapabilities
    ? ic.getPhotoCapabilities().catch(() => null)
    : Promise.resolve(null)
  let busy = false
  return {
    async take() {
      // One still at a time: a second ✓ while the first photo is in flight
      // keeps its video frame instead of queueing camera work.
      if (busy) return null
      busy = true
      try {
        const c = await caps
        const w = c?.imageWidth?.max
        const h = c?.imageHeight?.max
        return await ic.takePhoto(
          w && h ? { imageWidth: w, imageHeight: h } : undefined,
        )
      } catch (err) {
        console.warn(
          '[capture-feedback] takePhoto failed, using the video frame',
          err,
        )
        return null
      } finally {
        busy = false
      }
    },
  }
}

export function vibrateCaptured(): void {
  try {
    navigator.vibrate?.(60)
  } catch {
    /* unsupported */
  }
}

let audioCtx: AudioContext | null = null

/** Short high beep. The AudioContext is created lazily on the first ✓,
 *  which follows the user's start tap, so autoplay policies allow it. */
export function beepCaptured(): void {
  try {
    audioCtx ??= new AudioContext()
    const ctx = audioCtx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 1320
    gain.gain.setValueAtTime(0.15, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.12)
  } catch {
    /* no audio */
  }
}

/** Decode a photo blob into a canvas (EXIF orientation applied). */
export async function blobToImageCanvas(
  blob: Blob,
): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')?.drawImage(bmp, 0, 0)
  bmp.close()
  return canvas
}
