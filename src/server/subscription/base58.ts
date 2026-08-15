const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58EncodeUtf8(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length === 0) return '';
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let encoded = '';
  while (number > 0n) {
    encoded = ALPHABET[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return '1'.repeat(zeros) + encoded;
}

export function base58DecodeUtf8(value: string): string {
  if (value.length === 0) return '';
  let number = 0n;
  for (const character of value) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('Invalid Base58 character');
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
  const bytes = Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...decoded]);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Invalid UTF-8 in Base58 payload'); }
}
