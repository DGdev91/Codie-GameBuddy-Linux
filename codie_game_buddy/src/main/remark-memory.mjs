// Bounded session memory for semantic comparisons in the existing model turn.
// Keep games separate and retain older observations after the last-five window.
export function createRemarkMemory({ maxGames = 20, maxRemarks = 30, maxChars = 3000 } = {}) {
  const games = new Map();
  const keyOf = game => game ? `${game.process.toLowerCase()}\n${game.name.toLowerCase()}` : null;
  return {
    get(game) { return [...(games.get(keyOf(game)) ?? [])]; },
    add(game, text) {
      const key = keyOf(game);
      const said = String(text).replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!key || !said) return;
      const remarks = [said, ...(games.get(key) ?? [])].slice(0, maxRemarks);
      while (remarks.join('').length > maxChars) remarks.pop();
      games.delete(key);
      games.set(key, remarks);
      while (games.size > maxGames) games.delete(games.keys().next().value);
    },
  };
}
