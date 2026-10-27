import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import type { Awareness } from 'y-protocols/awareness';

import { isViewport as valid, type Viewport } from '../../shared/board-controls';
import { readViewport as viewport, applyViewport } from './viewport';

function equal(a: Viewport, b: Viewport) {
  return Math.abs(a.x - b.x) < 0.00001 && Math.abs(a.y - b.y) < 0.00001 && a.zoom === b.zoom;
}

// Excalidraw supplies the avatar/follow UI; the host must transport and apply
// the camera. Send the center and exact zoom so different viewport sizes agree.
export function installFollowing(api: ExcalidrawImperativeAPI, awareness: Awareness) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const publish = (next: Viewport, following: string | null) => {
    const local = awareness.getLocalState();
    if (
      local &&
      (!valid(local.viewport) || !equal(next, local.viewport) || local.following !== following)
    )
      awareness.setLocalState({ ...local, viewport: next, following });
  };
  const update = () => {
    timer = undefined;
    const state = api.getAppState();
    const following = state.userToFollow?.socketId ?? null;
    const states = awareness.getStates();
    if (following) {
      // A follower may itself be followed, but circular chains must not feed back.
      const visited = new Set([String(awareness.clientID)]);
      let id: string | null = following;
      while (id) {
        if (visited.has(id)) {
          api.updateScene({
            appState: { userToFollow: null },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          return;
        }
        visited.add(id);
        const next: unknown = states.get(Number(id))?.following;
        id = typeof next === 'string' ? next : null;
      }
      const remote = states.get(Number(following));
      if (!remote) {
        api.updateScene({
          appState: { userToFollow: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        return;
      }
      if (valid(remote.viewport) && !equal(viewport(state), remote.viewport)) {
        api.updateScene({
          appState: applyViewport(state, remote.viewport),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        // Forward the same target to downstream followers even during continuous movement.
        publish(remote.viewport, following);
        return;
      }
    }
    const followers = new Set<SocketId>();
    for (const [id, value] of states)
      if (value.following === String(awareness.clientID)) followers.add(String(id) as SocketId);
    if (
      followers.size !== state.followedBy.size ||
      [...followers].some((id) => !state.followedBy.has(id))
    )
      api.updateScene({
        appState: { followedBy: followers },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    publish(viewport(state), following);
  };
  const schedule = () => {
    if (!disposed && !timer) timer = setTimeout(update, 40);
  };
  const unsubscribe = api.onChange(schedule);
  awareness.on('change', schedule);
  schedule();
  return () => {
    disposed = true;
    clearTimeout(timer);
    unsubscribe();
    awareness.off('change', schedule);
  };
}
