/**
 * Global animation gate.
 *
 * The capture harness holds every CSS animation at a chosen frame so a still
 * can be judged. Anything that would otherwise start an entry animation after
 * that point has to skip it, or it freezes at its first keyframe — which for
 * a fade-in means invisible.
 */

let frozen = false;

export function setMotionFrozen(value: boolean): void {
  frozen = value;
}

export function motionFrozen(): boolean {
  return frozen;
}
