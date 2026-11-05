/**
 * Named reader timings and thresholds. Every value here is the one the
 * physically signed-off reader already used; they are named, not retuned.
 */

/** A tap may move this far (CSS px) and still count as a tap. */
export const TAP_MOVEMENT_PX = 10;
/** A touch held longer than this is not a tap. */
export const TAP_MAX_DURATION_MS = 400;
/**
 * A single tap waits this long before acting so a second tap can turn it into
 * a double tap. Slightly longer than `isDoubleTap`'s 320 ms window, so the
 * deferred action never fires while a double tap could still be recognized.
 */
export const CHROME_TAP_DELAY_MS = 330;
/** Holding one finger still this long starts text selection. */
export const LONG_PRESS_MS = 480;
/** Movement (CSS px) that turns an undecided touch into a drag. */
export const DRAG_ACTIVATION_PX = 8;
/** Touches this close to a screen edge (CSS px) are claimed from Safari's back swipe. */
export const EDGE_TOUCH_PX = 28;
/** Finger touches stay ignored this long after the Pencil lifts. */
export const PEN_TOUCH_SUPPRESSION_MS = 250;
/** Horizontal must exceed vertical by this ratio to count as horizontal, and vice versa. */
export const AXIS_DOMINANCE_RATIO = 1.15;

/** Exponential smoothing weight of each new page-turn velocity sample. */
export const PAGE_VELOCITY_SAMPLE_WEIGHT = 0.45;
/** Exponential smoothing weight of each new grid, continuous, or panel velocity sample. */
export const SCROLL_VELOCITY_SAMPLE_WEIGHT = 0.35;

/** Release velocities (px/ms) below these do not start momentum. */
export const CONTINUOUS_MOMENTUM_MIN_VELOCITY = 0.05;
export const GRID_MOMENTUM_MIN_VELOCITY = 0.05;
export const GRID_MOMENTUM_STOP_VELOCITY = 0.02;
export const PANEL_MOMENTUM_MIN_VELOCITY = 0.03;
export const PANEL_MOMENTUM_STOP_VELOCITY = 0.015;
/** Release velocity multipliers when momentum starts. */
export const CONTINUOUS_RELEASE_GAIN = 1.4;
export const GRID_RELEASE_GAIN = 1.5;
export const PANEL_RELEASE_GAIN = 1.25;
/** How far ahead (ms of velocity) a grid fling projects into the end bounce. */
export const GRID_BOUNCE_PROJECTION_MS = 12;
/** Fraction of the remaining fling velocity handed to the end spring. */
export const GRID_SPRING_HANDOFF = 0.15;
/** Constraint corrections smaller than this (px) do not count as hitting a bound. */
export const GRID_BOUND_EPSILON_PX = 0.1;
/** Bounce displacement (px) treated as at rest. */
export const GRID_REST_EPSILON_PX = 0.01;

/** Duration of grid/page semantic settles and the return-to-fit zoom. */
export const SEMANTIC_SETTLE_MS = 180;
/** Settle used instead of motion when Reduce Motion is on. */
export const REDUCED_MOTION_SETTLE = { durationMilliseconds: 1, initialControlY: 0.28 } as const;
/** Camera scales at or below this count as fit-page. */
export const FIT_SCALE_TOLERANCE = 1.01;
/** Smallest semantic transform scale used while morphing between page and grid. */
export const MIN_TRANSITION_SCALE = 0.01;

/** Maximum raster device-pixel ratios per surface. */
export const PAGE_DPR_CAP = 2.5;
export const CONTINUOUS_DPR_CAP = 2;
export const THUMBNAIL_DPR_CAP = 2;
/** Raster DPR of thumbnails prefetched outside the visible grid. */
export const PREFETCH_THUMBNAIL_DPR = 0.6;

/** Normalized distance a dragged selection may reach for the nearest character. */
export const SELECTION_HIT_TOLERANCE = 0.08;
/** Normalized padding around a selection that still counts as touching it. */
export const SELECTION_TOUCH_PAD = 0.012;
/** Pencil pressure used when the device reports none. */
export const DEFAULT_PEN_PRESSURE = 0.5;
/** Base CSS width of a Pencil stroke before pressure scaling. */
export const INK_BASE_WIDTH = 2.2;

/** Find waits this long after typing stops before scanning. */
export const SEARCH_INPUT_DEBOUNCE_MS = 220;
/** Retry interval while an import waits for another document to finish opening. */
export const IMPORT_RETRY_MS = 100;
/** Reading positions are saved this long after the last change. */
export const POSITION_SAVE_DEBOUNCE_MS = 500;

/** Status message display durations. */
export const STATUS_SHORT_MS = 1400;
export const STATUS_BRIEF_MS = 1600;
export const STATUS_DEFAULT_MS = 1800;
export const STATUS_MEDIUM_MS = 2000;
export const STATUS_ERROR_MS = 2200;
export const STATUS_LONG_MS = 2600;
