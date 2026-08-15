import { describe, expect, test } from 'vitest';
import { formatJsonPreservingContent } from '../src/client/json-format';

describe('JSON editor formatting', () => {
  test('formats JSON without removing duplicate keys or changing string content', () => {
    const source = '{"api_site":{"same":{"name":"第一项","api":"https://one.example/?q=a,b"},"same":{"name":"第二项","api":"https://two.example/"}}}';
    const formatted = formatJsonPreservingContent(source);
    expect(formatted.match(/"same"/g)).toHaveLength(2);
    expect(formatted).toContain('"https://one.example/?q=a,b"');
    expect(formatted).toContain('\n');
  });

  test('rejects invalid JSON without producing replacement content', () => {
    expect(() => formatJsonPreservingContent('{broken')).toThrow();
  });
});
