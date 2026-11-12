/**
 * 文件 → mediaType 的判定（纯函数，只在 host 侧使用）。
 *
 * 上传附件、群文件浏览、附件下载三处必须用同一套判定：以前这段写在 `im-api.ts` 里，
 * 群文件接口也要用，抽出来避免两套扩展名表漂移。
 */

export const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'txt', 'css', 'scss',
  'yml', 'yaml', 'toml', 'py', 'go', 'rs', 'java', 'sh', 'ps1', 'csv', 'log', 'xml', 'html',
])

export function mediaTypeFor(name: string, declared?: string): string {
  if (declared?.trim()) return declared.trim()
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'svg') return 'image/svg+xml'
  if (['md', 'txt', 'log', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'yml', 'yaml', 'toml', 'py', 'go', 'rs', 'java', 'sh', 'ps1', 'csv', 'xml', 'html'].includes(ext)) return 'text/plain'
  if (ext === 'json') return 'application/json'
  return 'application/octet-stream'
}

/** 是否按文本处理（预览/内联）。mediaType 优先，扩展名兜底。 */
export function isTextLike(name: string, mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return true
  if (mediaType === 'application/json' || mediaType === 'application/xml') return true
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.has(ext)
}
