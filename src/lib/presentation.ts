import { formatTwd } from '../domain/money';

// Proposal differences may be negative; amounts still use the domain's exact
// integer formatter instead of a separate floating-point currency formatter.
export const money = (minor: number) => minor < 0 ? `-${formatTwd(-minor)}` : formatTwd(minor);

export const destinations = [
  { id: 'xiaoliuqiu', name: '小琉球', note: '島嶼日常・慢慢安排' },
  { id: 'green-island', name: '綠島', note: '離島時光・保留彈性' },
  { id: 'kenting', name: '墾丁', note: '南國海岸・自在探索' },
] as const;
