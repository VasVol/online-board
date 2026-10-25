export interface Point {
  x: number;
  y: number;
}
export function circleBounds(start: Point, end: Point) {
  const size = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
  return {
    x: end.x < start.x ? start.x - size : start.x,
    y: end.y < start.y ? start.y - size : start.y,
    width: size,
    height: size,
  };
}
export function isTextTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (!!target.closest('input,textarea,select,[contenteditable="true"]') || target.isContentEditable)
  );
}
