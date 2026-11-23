/**
 * Where the dashboard window opens, and how big.
 *
 * A fixed 1280×860 opened taller than the dashboard's first page, leaving an empty band under the
 * table that the user dragged away, and on a small screen it could run behind the Dock. Instead:
 *
 *  - The first window is sized to the Traces page (PREFERRED_SIZE), fits the display's work area (the screen minus menu bar, Dock and taskbar)
 *    with a margin, capped at the preferred size, and is centred in it.
 *  - After that the window opens where the user left it: its last normal (un-maximised) bounds and
 *    whether it was maximised, kept in desktop-prefs.json.
 *  - A remembered position is checked against the displays attached now. A window last seen on a
 *    monitor that is gone, or bigger than the screen it lands on (a resolution change), is moved
 *    and shrunk onto the nearest one rather than opening off-screen.
 *
 * No `electron` import here, so the arithmetic is unit-tested without a display; window.ts and
 * main.ts pass in what `screen` reports.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindowState {
  /** The window's normal bounds: what it returns to when un-maximised. */
  bounds: Rect
  maximized: boolean
}

/**
 * The size the window opens at on a screen with room for it. The height is the Traces page's:
 * a full page of 20 rows plus the pager ends ~720px down, so 770 (the macOS title bar takes ~32)
 * opens with no empty band below the table. 860 left ~100px of nothing on the first screen.
 */
export const PREFERRED_SIZE = { width: 1280, height: 770 } as const
/** Below this the dashboard's tables stop being useful. Lowered only on a screen smaller still. */
export const MIN_SIZE = { width: 720, height: 480 } as const
/** Space kept between a first-launch window and the edges of the work area. */
export const SCREEN_MARGIN = 32
/** How much of a remembered window must still be on a display for that position to be kept. */
const MIN_VISIBLE = { width: 160, height: 80 } as const

export interface InitialWindowBounds {
  bounds: Rect
  maximized: boolean
  minWidth: number
  minHeight: number
}

/**
 * The bounds to create the window with.
 *
 * @param workAreas every attached display's work area, in Electron's screen coordinates.
 * @param primary the work area to use when nothing is remembered or the remembered spot is gone.
 */
export function initialWindowBounds(saved: SavedWindowState | undefined, workAreas: readonly Rect[], primary: Rect): InitialWindowBounds {
  if (saved) {
    const home = bestDisplayFor(saved.bounds, workAreas)
    if (home) return withMinimums(fitInto(saved.bounds, home), home, saved.maximized)
    // The display it was on is gone: keep the size the user chose, centred on the primary.
    return withMinimums(centreIn(clampSize(saved.bounds, primary), primary), primary, saved.maximized)
  }
  const size = {
    width: Math.min(PREFERRED_SIZE.width, primary.width - 2 * SCREEN_MARGIN),
    height: Math.min(PREFERRED_SIZE.height, primary.height - 2 * SCREEN_MARGIN),
  }
  return withMinimums(centreIn({ x: 0, y: 0, ...size }, primary), primary, false)
}

/** The display holding most of `bounds`, when enough of it is visible there to grab the title bar. */
function bestDisplayFor(bounds: Rect, workAreas: readonly Rect[]): Rect | undefined {
  let best: Rect | undefined
  let bestArea = 0
  for (const area of workAreas) {
    const overlap = intersect(bounds, area)
    if (!overlap || overlap.width < Math.min(MIN_VISIBLE.width, bounds.width) || overlap.height < Math.min(MIN_VISIBLE.height, bounds.height)) continue
    const a = overlap.width * overlap.height
    if (a > bestArea) { best = area; bestArea = a }
  }
  return best
}

/** Shrink to the work area if needed, then slide fully inside it. */
function fitInto(bounds: Rect, area: Rect): Rect {
  const sized = clampSize(bounds, area)
  return {
    ...sized,
    x: Math.min(Math.max(sized.x, area.x), area.x + area.width - sized.width),
    y: Math.min(Math.max(sized.y, area.y), area.y + area.height - sized.height),
  }
}

function clampSize(bounds: Rect, area: Rect): Rect {
  return { ...bounds, width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height) }
}

function centreIn(bounds: Rect, area: Rect): Rect {
  return {
    ...bounds,
    x: area.x + Math.round((area.width - bounds.width) / 2),
    y: area.y + Math.round((area.height - bounds.height) / 2),
  }
}

/** The minimum size, lowered on a screen too small for it, and the bounds raised to meet it. */
function withMinimums(bounds: Rect, area: Rect, maximized: boolean): InitialWindowBounds {
  const minWidth = Math.min(MIN_SIZE.width, area.width)
  const minHeight = Math.min(MIN_SIZE.height, area.height)
  const width = Math.max(bounds.width, minWidth)
  const height = Math.max(bounds.height, minHeight)
  const grown = width === bounds.width && height === bounds.height ? bounds : fitInto({ ...bounds, width, height }, area)
  return { bounds: grown, maximized, minWidth, minHeight }
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined
}

/** A remembered window state read back from prefs, or undefined if it is missing or malformed. */
export function parseSavedWindowState(raw: unknown): SavedWindowState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { bounds, maximized } = raw as Record<string, unknown>
  if (!bounds || typeof bounds !== 'object') return undefined
  const { x, y, width, height } = bounds as Record<string, unknown>
  const ints = [x, y, width, height]
  if (!ints.every(n => typeof n === 'number' && Number.isFinite(n))) return undefined
  if ((width as number) < 1 || (height as number) < 1) return undefined
  return {
    bounds: { x: Math.round(x as number), y: Math.round(y as number), width: Math.round(width as number), height: Math.round(height as number) },
    maximized: maximized === true,
  }
}
