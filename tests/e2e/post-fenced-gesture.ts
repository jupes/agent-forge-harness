/** Test gestures may repeat only before any request or exact effect is observed. */
export function createPostFencedGesture(options: {
  posts(): number;
  applied(): boolean;
  ready(): Promise<void>;
  gesture(): Promise<void>;
}) {
  const postsBefore = options.posts();
  const closed = () => options.applied() || options.posts() !== postsBefore;
  return {
    postsBefore,
    async attempt() {
      if (closed()) return;
      await options.ready();
      if (closed()) return;
      await options.gesture();
    },
  };
}
