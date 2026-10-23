import { expect, test } from "bun:test";
import { createPostFencedGesture } from "../../tests/e2e/post-fenced-gesture";

test("an unsent gesture can repeat, but a sent request with a lost answer can only be observed", async () => {
  let posts = 0,
    gestures = 0,
    applied = false;
  const fence = createPostFencedGesture({
    posts: () => posts,
    applied: () => applied,
    ready: async () => {},
    gesture: async () => {
      gestures++;
      if (gestures === 1) return; // A background refresh consumed the native gesture.
      posts++;
      throw Error("The click answer was lost after its request was observed");
    },
  });
  await fence.attempt();
  expect({ posts, gestures }).toEqual({ posts: 0, gestures: 1 });
  await expect(fence.attempt()).rejects.toThrow("answer was lost");
  await fence.attempt();
  await fence.attempt();
  expect({ posts, gestures, applied }).toEqual({
    posts: 1,
    gestures: 2,
    applied: false,
  });
  applied = true;
  await fence.attempt();
  expect({ posts, gestures }).toEqual({ posts: 1, gestures: 2 });
});

test("a POST observed while readiness is held closes the gesture boundary before activation", async () => {
  let posts = 4,
    gestures = 0,
    release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fence = createPostFencedGesture({
    posts: () => posts,
    applied: () => false,
    ready: () => ready,
    gesture: async () => {
      gestures++;
    },
  });
  const waiting = fence.attempt();
  posts++;
  release();
  await waiting;
  await fence.attempt();
  expect(fence.postsBefore).toBe(4);
  expect({ posts, gestures }).toEqual({ posts: 5, gestures: 0 });
});

test("an exact applied effect closes the boundary even before the request observer catches up", async () => {
  let readiness = 0,
    gestures = 0;
  const fence = createPostFencedGesture({
    posts: () => 0,
    applied: () => true,
    ready: async () => {
      readiness++;
    },
    gesture: async () => {
      gestures++;
    },
  });
  await fence.attempt();
  expect({ readiness, gestures }).toEqual({ readiness: 0, gestures: 0 });
});
