// One device turn at a time (spec §4.1): commentary skips while busy; the
// hotkey and look_at_game wait their turn.
export function createTurnLock() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    get busy() { return pending > 0; },
    run(fn) {
      pending++;
      const result = tail.then(fn);
      const settle = () => { pending--; };
      tail = result.then(settle, settle);
      return result;
    },
  };
}
