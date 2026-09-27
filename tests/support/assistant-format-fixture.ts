// Synthetic travel text reproducing the observed Cloudflare **strong** and
// '* ' multiline syntax. This is not a transcript or live-quality evidence.
export const assistantFormatSample = [
  '已整理這趟行程，**修改前請先確認**。',
  '',
  '* **第二天下午**：留白，保留彈性。',
  '* 行程代碼為 `transfer`，確認後才套用。',
  '',
  '所有價格仍為 DEMO。',
  '不代表可訂狀態或安全建議。',
].join('\n');

export const assistantUnsafeSample = [
  '<script>globalThis.__assistantInjected = true</script>',
  '<img src="https://example.invalid/pixel" onerror="globalThis.__assistantInjected = true">',
  '[點我](javascript:alert(1))',
  '![圖片](https://example.invalid/image.png)',
  '<https://example.invalid/autolink>',
  'https://example.invalid/plain',
].join('\n');
