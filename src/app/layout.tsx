import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: '潛旅筆記 · Dive Trip', description: '一份可以慢慢調整的潛旅行程。互動示範，非預訂服務。',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-Hant"><body>
    <a className="skip-link" href="#main">跳至主要內容</a>
    <header className="site-header"><a className="brand" href="/"><span className="brand-mark" aria-hidden="true">≈</span>潛旅筆記 <small>DIVE TRIP</small></a><span className="badge">互動 DEMO</span></header>
    {children}
    <footer className="site-footer">練習規劃，也練習留白。<span>示範資料非真實報價或可訂保證；本工具不提供潛水安全背書。</span></footer>
  </body></html>;
}
