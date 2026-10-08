// The one annotation palette, shared with the render
// (api/src/services/help-video-annotations.ts PALETTE). Videos look the same
// in every host app; they do not follow the host's brand colour.
export const ANNOTATION_PALETTE = {
  accent: '#2563eb',
  warning: '#dc2626',
  neutral: '#111827'
} as const

export function annotationUnit(frameWidth: number): number {
  return Math.max(2, Math.round(frameWidth / 640))
}
