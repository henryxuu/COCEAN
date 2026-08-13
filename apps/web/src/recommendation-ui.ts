export function localDayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function catalogSourceUrl(value: string): string | null {
  return /^https?:\/\/[^\s]+$/i.test(value) ? value : null;
}

export function domainLabel(value: string): string {
  return (
    (
      {
        classical: "古典",
        jazz: "爵士",
        pop: "流行",
        soundtrack: "原声",
        ambient: "氛围",
        electronic: "电子",
        world: "世界音乐",
      } as Record<string, string>
    )[value] ?? value
  );
}

export function featureLabel(value: string): string {
  const token = value.split(":").at(-1) ?? value;
  return (
    (
      {
        warm: "温暖",
        dark: "暗色",
        soft: "柔和",
        spacious: "开阔",
        sparse: "留白",
        steady: "稳定",
        clear: "清晰",
        airy: "通透",
        acoustic: "原声",
        continuous: "连续",
        "album-arc": "完整弧线",
      } as Record<string, string>
    )[token] ?? token.replaceAll("-", " ")
  );
}
