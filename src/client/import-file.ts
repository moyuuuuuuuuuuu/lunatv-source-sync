const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58Utf8(value: string): string {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('文件既不是有效 JSON，也不是有效 Base58');
    number = number * 58n + BigInt(digit);
  }
  const decoded: number[] = [];
  while (number > 0n) {
    decoded.push(Number(number % 256n));
    number /= 256n;
  }
  decoded.reverse();
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === '1') leadingZeros += 1;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...decoded])); }
  catch { throw new Error('Base58 文件解码后不是有效 UTF-8'); }
}

export function parseImportFile(text: string): unknown {
  const content = text.replace(/^\uFEFF/, '').trim();
  if (!content) throw new Error('文件内容为空');
  try { return JSON.parse(content); }
  catch {
    try { return JSON.parse(decodeBase58Utf8(content).replace(/^\uFEFF/, '').trim()); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('Base58 解码成功，但内容不是有效 JSON');
      throw error;
    }
  }
}
