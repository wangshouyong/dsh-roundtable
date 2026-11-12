/**
 * 面板内联图标（16px 线性图标，currentColor 取色）。
 *
 * 为什么不直接用 emoji / 符号字符：👥📄🖼♔ 这些字形在 Windows / macOS / DSH 内嵌
 * 浏览器里字体不一致，大小、基线、颜色都不可控（之前在成员卡上明显偏色、偏大）。
 * 统一用 SVG 才能和 13px 正文对齐、跟随主题色。
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base(props: IconProps) {
  const { size = 16, ...rest } = props
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  }
}

/** 群 / 多人 */
export function IconUsers(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="6" cy="5.6" r="2.1" />
      <path d="M2.2 13c0-2 1.7-3.4 3.8-3.4s3.8 1.4 3.8 3.4" />
      <path d="M10.4 3.7a2.1 2.1 0 0 1 0 4" />
      <path d="M11.6 9.9c1.4.4 2.4 1.6 2.4 3.1" />
    </svg>
  )
}

/** 私聊气泡 */
export function IconChat(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M13.5 8c0 2.9-2.5 5.2-5.5 5.2-.7 0-1.5-.1-2.1-.4L2.6 13.4l.8-2.5A4.9 4.9 0 0 1 2.5 8C2.5 5.1 5 2.8 8 2.8S13.5 5.1 13.5 8Z" />
    </svg>
  )
}

/** 搜索 */
export function IconSearch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="7" cy="7" r="4.3" />
      <path d="m10.3 10.3 3 3" />
    </svg>
  )
}

/** 加号 */
export function IconPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

/** 附件（回形针） */
export function IconPaperclip(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10.9 7.4 8 10.3a2.2 2.2 0 0 1-3.1-3.1l3.4-3.4a1.7 1.7 0 0 1 2.4 2.4L7.4 9.5a1.1 1.1 0 0 1-1.6-1.6l2.6-2.6" />
    </svg>
  )
}

/** 发送 */
export function IconSend(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M13.4 2.6 7.1 8.9M13.4 2.6 9.6 13.4 7.1 8.9 2.6 6.4z" />
    </svg>
  )
}

/** 关闭 */
export function IconClose(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  )
}

/** 更多 */
export function IconMore(props: IconProps) {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <circle cx="3.4" cy="8" r="0.6" fill="currentColor" />
      <circle cx="8" cy="8" r="0.6" fill="currentColor" />
      <circle cx="12.6" cy="8" r="0.6" fill="currentColor" />
    </svg>
  )
}

/** 右箭头（进入 / 详情） */
export function IconChevronRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  )
}

/** 下箭头（展开 / 下拉） */
export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m3.5 6 4.5 4.5L12.5 6" />
    </svg>
  )
}

/** 文件夹 */
export function IconFolder(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.2l1.2 1.5h5.4A1.6 1.6 0 0 1 14 6.1v5.3A1.6 1.6 0 0 1 12.4 13H3.6A1.6 1.6 0 0 1 2 11.4z" />
    </svg>
  )
}

/** 勾选 */
export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  )
}

/** 群主 / 主理人 */
export function IconCrown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2.5 11.5h11M3 10 2 4.8l3.4 2.1L8 3.2l2.6 3.7L14 4.8 13 10z" />
    </svg>
  )
}

/** 文件 */
export function IconFile(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.8v3h3" />
    </svg>
  )
}

/** 图片 */
export function IconImage(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.5" />
      <circle cx="6" cy="6.6" r="1.05" />
      <path d="m3 11.4 3.2-3 2.2 2 1.7-1.5 2.9 2.5" />
    </svg>
  )
}

/** 状态点（在线 / 运行中） */
export function IconDot(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 警告（失败 / 暂停态状态条） */
export function IconAlert(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 2.6 14 13H2L8 2.6Z" />
      <path d="M8 6.4v3.4" />
      <circle cx="8" cy="11.3" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconSpark(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 2.4 9.4 6l3.6 1.4L9.4 8.8 8 12.4 6.6 8.8 3 7.4 6.6 6z" />
    </svg>
  )
}

/** 回收站（删除 / 彻底删除） */
export function IconTrash(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2.8 4.4h10.4" />
      <path d="M6.2 4.4V3.2c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.2" />
      <path d="M4.2 4.4 4.8 13c.05.5.5.9 1 .9h4.4c.5 0 .95-.4 1-.9l.6-8.6" />
      <path d="M6.7 7v4.2M9.3 7v4.2" />
    </svg>
  )
}

/** 恢复（回收站 → 原位置） */
export function IconRestore(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.7" />
      <path d="M2.4 2.6v3.2h3.2" />
    </svg>
  )
}
