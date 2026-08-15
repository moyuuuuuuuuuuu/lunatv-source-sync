export interface ClassifiableSource {
  sourceKey?: string;
  name?: string;
  api?: string;
  detail?: string | null;
  comment?: string | null;
}

const BUILT_IN_KEYWORDS = [
  '18+', 'adult', 'av', 'porn', 'porno', 'sex', 'xxx', 'hentai',
  '成人视频', '成人', '情色', '色情', '福利', '无码', '有码', '里番',
];

export function classifyAdult(
  input: ClassifiableSource,
  extraKeywords: readonly string[] = [],
): boolean {
  const haystack = [input.sourceKey, input.name, input.api, input.detail, input.comment]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLocaleLowerCase();

  return [...BUILT_IN_KEYWORDS, ...extraKeywords]
    .map((keyword) => keyword.trim().toLocaleLowerCase())
    .filter(Boolean)
    .some((keyword) => {
      if (/^[a-z0-9]+$/.test(keyword) && keyword.length <= 3) {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
      }
      return haystack.includes(keyword);
    });
}
