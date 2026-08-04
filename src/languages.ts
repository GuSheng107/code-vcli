export interface SupportedLanguage {
  code: string;
  name: string;
}

// 经 DLX 接口实测支持的 31 个目标语言代码。
// EN、PT 为直接可用代码；EN-GB、EN-US、ES-419、HE、PT-BR、PT-PT、VI 不可用，已剔除。
// ZH 默认简体，ZH-HANT 繁体，不再单独保留 ZH-HANS。
export const TARGET_LANGUAGES: readonly SupportedLanguage[] = [
  { code: "AR", name: "阿拉伯语" },
  { code: "BG", name: "保加利亚语" },
  { code: "CS", name: "捷克语" },
  { code: "DA", name: "丹麦语" },
  { code: "DE", name: "德语" },
  { code: "EL", name: "希腊语" },
  { code: "EN", name: "英语" },
  { code: "ES", name: "西班牙语" },
  { code: "ET", name: "爱沙尼亚语" },
  { code: "FI", name: "芬兰语" },
  { code: "FR", name: "法语" },
  { code: "HU", name: "匈牙利语" },
  { code: "ID", name: "印度尼西亚语" },
  { code: "IT", name: "意大利语" },
  { code: "JA", name: "日语" },
  { code: "KO", name: "韩语" },
  { code: "LT", name: "立陶宛语" },
  { code: "LV", name: "拉脱维亚语" },
  { code: "NB", name: "挪威博克马尔语" },
  { code: "NL", name: "荷兰语" },
  { code: "PL", name: "波兰语" },
  { code: "PT", name: "葡萄牙语" },
  { code: "RO", name: "罗马尼亚语" },
  { code: "RU", name: "俄语" },
  { code: "SK", name: "斯洛伐克语" },
  { code: "SL", name: "斯洛文尼亚语" },
  { code: "SV", name: "瑞典语" },
  { code: "TR", name: "土耳其语" },
  { code: "UK", name: "乌克兰语" },
  { code: "ZH", name: "中文（默认简体）" },
  { code: "ZH-HANT", name: "繁体中文" },
] as const;

export function getLanguagesJson(): string {
  return JSON.stringify({
    ok: true,
    data: {
      target_count: TARGET_LANGUAGES.length,
      target_languages: TARGET_LANGUAGES,
      source_auto: true,
    },
  });
}

export function getLanguagesText(): string {
  const rows = TARGET_LANGUAGES.map(({ code, name }) => `  ${code.padEnd(8)} ${name}`);
  return [
    `目标语言：${TARGET_LANGUAGES.length} 个代码`,
    ...rows,
    "",
    "源语言：支持 AUTO，以及上述所有代码",
  ].join("\n");
}
