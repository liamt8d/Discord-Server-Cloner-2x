const header = [
  '  _ _                 ',
  ' | (_) __ _ _ __ ___  ',
  ' | | |/ _` | \'_ ` _ \\ ',
  ' | | | (_| | | | | | |',
  ' |_|_|\\__,_|_| |_| |_|',
  '       liam · ft8d',
  ' CLONADOR DE COMUNIDADES',
  '    v3.1.2 · Termux'
];

/** Compact gradient that fits a mobile terminal, with no extra dependencies. */
export function renderHeader(color = true): string {
  return '\n' + header.map((line) => {
    if (!color) return line;
    const characters = Array.from(line);
    return characters.map((character, index) => {
      const progress = index / Math.max(1, characters.length - 1);
      const red = Math.round(65 + 180 * progress);
      const green = Math.round(210 - 110 * progress);
      return `\u001b[38;2;${red};${green};255m${character}`;
    }).join('') + '\u001b[0m';
  }).join('\n') + '\n';
}
