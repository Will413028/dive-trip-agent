export const assistantUnsafeSample = [
  '<script>globalThis.__assistantInjected = true</script>',
  '<img src="https://example.invalid/pixel" onerror="globalThis.__assistantInjected = true">',
  '[點我](javascript:alert(1))',
  '![圖片](https://example.invalid/image.png)',
  '<https://example.invalid/autolink>',
  'https://example.invalid/plain',
].join('\n');
