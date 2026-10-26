import type { ActivityKind, TaskStatus } from '../types'

export const COLOR: Record<ActivityKind | TaskStatus, string> = {
  working: '#3b82f6',
  in_progress: '#3b82f6',
  waiting: '#f59e0b',
  input: '#8b5cf6',
  stopped: '#ef4444',
  failed: '#ef4444',
  done: '#22c55e',
}

// Desktop, VS Code and mobile draw these as SVG; SMIL animates them inside an interactive frame.
const svg = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">${body}</svg>`

export function taskIcon(status: TaskStatus): string {
  const color = COLOR[status]

  switch (status) {
    case 'in_progress':
      return svg(
        16,
        `<circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-opacity=".2" stroke-width="2"/>` +
          `<path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round">` +
          `<animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur=".9s" repeatCount="indefinite"/></path>`,
      )
    case 'done':
      return svg(
        16,
        `<circle cx="8" cy="8" r="7" fill="${color}"/>` +
          `<path d="M4.8 8.2l2.2 2.2 4.2-4.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
    case 'failed':
      return svg(
        16,
        `<circle cx="8" cy="8" r="7" fill="${color}"/>` +
          `<path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,
      )
    case 'waiting':
      return svg(16, `<circle cx="8" cy="8" r="6" fill="none" stroke="#9ca3af" stroke-width="1.6" stroke-dasharray="2.4 2.2"/>`)
  }
}

export function pulse(kind: ActivityKind): string {
  const color = COLOR[kind]

  return svg(
    18,
    `<circle cx="8" cy="8" r="4" fill="${color}" fill-opacity=".35">` +
      `<animate attributeName="r" values="4;7.5" dur="1.4s" repeatCount="indefinite"/>` +
      `<animate attributeName="fill-opacity" values=".35;0" dur="1.4s" repeatCount="indefinite"/></circle>` +
      `<circle cx="8" cy="8" r="4" fill="${color}"/>`,
  )
}

export const HOURGLASS = svg(
  14,
  `<g fill="none" stroke="${COLOR.waiting}" stroke-width="1.4" stroke-linejoin="round">` +
    `<path d="M4 2h8M4 14h8M5 2c0 4 6 4 6 6s-6 2-6 6M11 2c0 4-6 4-6 6s6 2 6 6"/>` +
    `<animateTransform attributeName="transform" type="rotate" values="0 8 8;0 8 8;180 8 8" keyTimes="0;.8;1" dur="2.4s" repeatCount="indefinite"/></g>`,
)

export function progressBar(width: number, ratio: number, isRunning: boolean, hasFailed: boolean): string {
  const fill = Math.round(width * ratio)
  const color = ratio === 1 ? COLOR.done : hasFailed ? COLOR.failed : COLOR.in_progress
  const shimmer = isRunning
    ? `<g clip-path="url(#f)"><rect x="-80" width="80" height="10" fill="url(#s)">` +
      `<animate attributeName="x" from="-80" to="${width}" dur="1.6s" repeatCount="indefinite"/></rect></g>`
    : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10">` +
    `<defs><clipPath id="f"><rect width="${fill}" height="10" rx="5"/></clipPath>` +
    `<linearGradient id="s"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
    `<stop offset=".5" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
    `<rect width="${width}" height="10" rx="5" fill="#9ca3af" fill-opacity=".25"/>` +
    `<rect width="${fill}" height="10" rx="5" fill="${color}"/>${shimmer}</svg>`
  )
}
