export function formatJsonPreservingContent(source: string): string {
  JSON.parse(source);

  let result = '';
  let indent = 0;
  let inString = false;
  let escaped = false;
  const padding = () => '  '.repeat(indent);
  const nextNonWhitespace = (start: number) => {
    let index = start;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    return source[index];
  };
  const previousNonWhitespace = (start: number) => {
    let index = start;
    while (index >= 0 && /\s/.test(source[index])) index -= 1;
    return source[index];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; result += character; continue; }
    if (/\s/.test(character)) continue;
    if (character === '{' || character === '[') {
      result += character;
      if (nextNonWhitespace(index + 1) !== (character === '{' ? '}' : ']')) { indent += 1; result += `\n${padding()}`; }
      continue;
    }
    if (character === '}' || character === ']') {
      if (previousNonWhitespace(index - 1) === (character === '}' ? '{' : '[')) { result += character; continue; }
      indent -= 1;
      result += `\n${padding()}${character}`;
      continue;
    }
    if (character === ',') { result += `,\n${padding()}`; continue; }
    if (character === ':') { result += ': '; continue; }
    result += character;
  }
  return result;
}
