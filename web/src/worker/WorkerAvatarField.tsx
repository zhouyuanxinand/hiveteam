import { ImagePlus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WorkerRole } from '../../../src/shared/types.js'
import { WORKER_AVATAR_MAX_CHARS } from '../../../src/shared/worker-avatar.js'
import { useI18n } from '../i18n.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'

const AVATAR_EDGE = 256

type Crop = {
  offsetX: number
  offsetY: number
  zoom: number
}

type LoadedImage = {
  image: HTMLImageElement
  name: string
}

type WorkerAvatarFieldProps = {
  avatar: string | null
  disabled?: boolean
  onChange: (avatar: string | null) => void
  workerRole: WorkerRole
}

const DEFAULT_CROP: Crop = { offsetX: 0, offsetY: 0, zoom: 1 }

const isSupportedImage = (file: File) =>
  file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp'

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the image.'))
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read the image.'))
    }
    reader.readAsDataURL(file)
  })

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onerror = () => reject(new Error('Could not decode the image.'))
    image.onload = () => resolve(image)
    image.src = src
  })

const cropImage = (image: HTMLImageElement, crop: Crop) => {
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_EDGE
  canvas.height = AVATAR_EDGE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot crop images.')

  context.fillStyle = '#171719'
  context.fillRect(0, 0, AVATAR_EDGE, AVATAR_EDGE)

  const baseScale = Math.max(AVATAR_EDGE / image.naturalWidth, AVATAR_EDGE / image.naturalHeight)
  const width = image.naturalWidth * baseScale * crop.zoom
  const height = image.naturalHeight * baseScale * crop.zoom
  const maxOffsetX = Math.max(0, (width - AVATAR_EDGE) / 2)
  const maxOffsetY = Math.max(0, (height - AVATAR_EDGE) / 2)
  const x = (AVATAR_EDGE - width) / 2 + maxOffsetX * (crop.offsetX / 100)
  const y = (AVATAR_EDGE - height) / 2 + maxOffsetY * (crop.offsetY / 100)
  context.drawImage(image, x, y, width, height)

  for (const quality of [0.88, 0.76, 0.64, 0.52]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    if (dataUrl.length <= WORKER_AVATAR_MAX_CHARS) return dataUrl
  }
  throw new Error('Avatar is too large after cropping. Try a different image.')
}

/**
 * Local-only image picker with a deliberately small, bounded crop surface.
 * Files are never uploaded: the resulting data URL is stored in the worker
 * record and validated again by the local runtime before persistence.
 */
export const WorkerAvatarField = ({
  avatar,
  disabled = false,
  onChange,
  workerRole,
}: WorkerAvatarFieldProps) => {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [crop, setCrop] = useState<Crop>(DEFAULT_CROP)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<LoadedImage | null>(null)

  useEffect(() => {
    if (!source) return
    try {
      onChange(cropImage(source.image, crop))
      setError(null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }, [crop, onChange, source])

  const chooseFile = () => inputRef.current?.click()
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const [file] = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!file) return
    if (!isSupportedImage(file)) {
      setError(t('worker.avatarUnsupported'))
      return
    }

    void readFileAsDataUrl(file)
      .then(loadImage)
      .then((image) => {
        setCrop(DEFAULT_CROP)
        setSource({ image, name: file.name })
        setError(null)
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : String(nextError))
      })
  }

  const clearAvatar = () => {
    setSource(null)
    setCrop(DEFAULT_CROP)
    setError(null)
    onChange(null)
  }

  return (
    <section className="flex flex-col gap-2" aria-labelledby="worker-avatar-label">
      <div className="flex items-baseline justify-between gap-2">
        <span id="worker-avatar-label" className="text-xs font-semibold text-sec">
          {t('worker.avatar')}
        </span>
        <span className="text-[11px] text-ter">{t('worker.avatarLocalOnly')}</span>
      </div>
      <div
        className="flex items-center gap-3 rounded-md border p-3"
        style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
      >
        <CliAgentAvatar avatar={avatar ?? undefined} workerRole={workerRole} size={52} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="text-xs text-sec">
            {source ? source.name : avatar ? t('worker.avatarSelected') : t('worker.avatarEmpty')}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={chooseFile}
              className="icon-btn icon-btn--tertiary"
              data-testid="worker-avatar-select"
            >
              <ImagePlus size={13} aria-hidden />
              {avatar ? t('worker.avatarReplace') : t('worker.avatarChoose')}
            </button>
            {avatar ? (
              <button
                type="button"
                disabled={disabled}
                onClick={clearAvatar}
                className="icon-btn icon-btn--tertiary"
                data-testid="worker-avatar-remove"
              >
                <Trash2 size={13} aria-hidden />
                {t('worker.avatarRemove')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        tabIndex={-1}
        onChange={handleFileChange}
        data-testid="worker-avatar-file-input"
      />
      {source ? (
        <div
          className="grid gap-2 rounded-md border p-3 text-xs text-sec sm:grid-cols-3"
          style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
        >
          <CropControl
            label={t('worker.avatarZoom')}
            value={crop.zoom}
            min={1}
            max={3}
            step={0.05}
            disabled={disabled}
            onChange={(zoom) => setCrop((current) => ({ ...current, zoom }))}
          />
          <CropControl
            label={t('worker.avatarHorizontal')}
            value={crop.offsetX}
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            onChange={(offsetX) => setCrop((current) => ({ ...current, offsetX }))}
          />
          <CropControl
            label={t('worker.avatarVertical')}
            value={crop.offsetY}
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            onChange={(offsetY) => setCrop((current) => ({ ...current, offsetY }))}
          />
          <button
            type="button"
            onClick={() => setCrop(DEFAULT_CROP)}
            disabled={disabled}
            className="icon-btn icon-btn--tertiary justify-self-start sm:col-span-3"
          >
            <RotateCcw size={13} aria-hidden /> {t('worker.avatarResetCrop')}
          </button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-[var(--status-red)]">{error}</p> : null}
    </section>
  )
}

type CropControlProps = {
  disabled: boolean
  label: string
  max: number
  min: number
  onChange: (value: number) => void
  step: number
  value: number
}

const CropControl = ({ disabled, label, max, min, onChange, step, value }: CropControlProps) => (
  <label className="flex min-w-0 flex-col gap-1">
    <span className="flex justify-between gap-2 text-[11px] text-ter">
      <span>{label}</span>
      <span className="mono text-sec">{step < 1 ? value.toFixed(2) : value}</span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  </label>
)
