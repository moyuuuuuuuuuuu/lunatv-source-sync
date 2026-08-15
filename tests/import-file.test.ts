import { describe, expect, test } from 'vitest';
import { parseImportFile } from '../src/client/import-file.js';
import { base58EncodeUtf8 } from '../src/server/subscription/base58.js';

describe('local import files', () => {
  test('parses JSON, Base58 JSON, BOM and surrounding whitespace', () => {
    const document = { cache_time: 7200, api_site: { demo: { name: 'Demo', api: 'https://example.com' } } };
    expect(parseImportFile(JSON.stringify(document))).toEqual(document);
    expect(parseImportFile(`  ${base58EncodeUtf8(JSON.stringify(document))}\n`)).toEqual(document);
    expect(parseImportFile(`\uFEFF${base58EncodeUtf8(JSON.stringify(document))}`)).toEqual(document);
  });

  test('returns useful errors for malformed files', () => {
    expect(() => parseImportFile('')).toThrow('文件内容为空');
    expect(() => parseImportFile('0OIl')).toThrow(/Base58/);
    expect(() => parseImportFile(base58EncodeUtf8('not json'))).toThrow(/不是有效 JSON/);
  });
});
