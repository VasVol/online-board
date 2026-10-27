import test from 'node:test';
import assert from 'node:assert/strict';
import { LaserTrails, LASER_IDLE_MS, LASER_FADE_MS } from '../src/canvas/laser';

const point = (x: number) => ({ x, y: 5, tool: 'laser' });
test('laser retains a long drawing and separate strokes until inactivity', () => {
  const model = new LaserTrails();
  for (let i = 0; i < 50; i++) model.update(1, point(i), 'down', i * 200);
  const trail = model.trails.get(1)!;
  assert.equal(trail.strokes[0].length, 50);
  assert.equal(model.opacity(trail, 9800), 1);
  model.update(1, point(49), 'up', 9900);
  model.update(1, point(100), 'down', 10000);
  assert.equal(trail.strokes.length, 2);
  assert.equal(trail.strokes[0][0].x, 0);
  assert.equal(model.opacity(trail, 10000 + LASER_IDLE_MS), 1);
  assert.equal(model.opacity(trail, 10000 + LASER_IDLE_MS + LASER_FADE_MS / 2), 0.5);
  assert.equal(model.opacity(trail, 10000 + LASER_IDLE_MS + LASER_FADE_MS), 0);
  assert.equal(trail.strokes.length, 0);
  // An unchanged awareness update must not replay a stale pointer after reconnect.
  model.update(1, point(100), 'down', 13000);
  assert.equal(trail.strokes.length, 0);
  model.update(1, point(101), 'down', 13200);
  assert.deepEqual(trail.strokes, [[{ x: 101, y: 5 }]]);
});

test('laser idle clocks are independent and ignore hover, release and heartbeat updates', () => {
  const model = new LaserTrails();
  model.update(1, point(0), 'down', 0);
  model.update(1, point(10), 'up', 100);
  model.update(1, point(20), 'up', 800);
  model.update(2, point(20), 'down', 800);
  model.update(2, point(20), 'down', 1000);
  assert.equal(model.trails.get(1)!.updated, 100);
  assert.equal(model.trails.get(2)!.updated, 800);
  assert.equal(model.opacity(model.trails.get(1)!, 1700), 0);
  assert.equal(model.opacity(model.trails.get(2)!, 1700), 1);
  model.update(2, { x: NaN, y: 0, tool: 'laser' }, 'down', 1750);
  assert.equal(model.trails.get(2)!.updated, 800);
  model.update(2, { x: 25, y: 0, tool: 'pointer' }, 'down', 1800);
  assert.equal(model.trails.get(2)!.updated, 800);
});
