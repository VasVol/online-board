/** Wheel panning remains available. Zoom uses explicit controls, not Ctrl+wheel/pinch. */
export function installSteadyZoom(root: HTMLElement) {
  const wheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  root.addEventListener('wheel', wheel, { capture: true, passive: false });
  return () => root.removeEventListener('wheel', wheel, true);
}
