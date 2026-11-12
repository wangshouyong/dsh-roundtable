/** 右栏（群）：「成员 / 任务板 / 候选 / 执行」四个 Tab 的面板。 */
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { FACT_KIND_LABEL } from '../../core/facts.ts'
import { CONSENSUS_STATUS_LABEL, type ConsensusState, type ConsensusStatus } from '../../core/consensus.ts'
import type { ImService } from '../../core/im.ts'
import type { FactKind, Thread, TurnTrace } from '../../core/types.ts'
import { stripLegacyReasoning } from '../../core/text.ts'
import { activityLabel } from '../../core/floor.ts'
import { Avatar } from '../Avatar.tsx'
import { IconChevronRight, IconCrown, IconMore, IconSearch } from './icons.tsx'
import { GroupFilesPane } from './group-files.tsx'
import { ACTIVITIES, fmt, jumpToSourceMessage, memberChips } from './shared.tsx'

/** 徽标颜色：状态 → 点。candidate 灰、进行/有效绿、失败红、派生蓝。 */
function consensusDotClass(status: ConsensusStatus): string {
  if (status === 'candidate') return ''
  if (status === 'resolved' || status === 'superseded' || status === 'expired' || status === 'archived') return ''
  return 'done'
}

export function RoundPlan(props: { im: ImService; thread: Thread }) {
  const { im, thread } = props
  const lastDecision = thread.floorDecisions?.at(-1)
  const waitTarget = lastDecision?.action === 'wait' ? lastDecision.personaId : undefined
  return (
    <div className="plan">
      <h2>本轮安排</h2>
      {thread.members.map((m) => {
        const p = im.state.personas.find((x) => x.id === m.personaId)
        if (!p) return null
        const run = thread.speakingPersonaId === m.personaId
        const done = m.completedRound || m.passedRound
        const waiting = waitTarget === m.personaId
        return (
          <div key={m.personaId} className="plan-row">
            <span className={`dot ${run ? 'run' : done ? 'done' : ''}`} />
            发言人：{p.name}
            <span className="status">{run ? '进行中' : waiting ? '正在处理，等它完成' : done ? (m.passedRound ? '已弃权' : '已完成') : '待开始'}</span>
          </div>
        )
      })}
      <div className="plan-foot">本轮 {thread.members.length} 位专家发言，排队后结束。</div>
    </div>
  )
}

export const FACT_ORDER: FactKind[] = ['decision', 'todo', 'commitment', 'constraint', 'stance', 'fact']

/** 共识状态板：A 用户指令 / B 群共识 / C 任务；D 归档只显示计数。开关打开且已有状态时替换旧事实板。 */
export const CONSENSUS_LANE_TITLE: Record<'A' | 'B' | 'C', string> = {
  A: '用户指令',
  B: '群共识',
  C: '任务',
}

export function consensusStatusRank(status: ConsensusStatus): number {
  if (status === 'candidate') return 0
  if (status === 'active' || status === 'applied' || status === 'done') return 1
  if (status === 'resolved') return 2
  if (status === 'superseded') return 3
  if (status === 'expired') return 4
  return 5
}

/** 临时布局自检：DSH 里任务板高度不对时，让用户截图就能看到真实 top/height。
 *  默认不显示（控制台 `localStorage.setItem('dsh-im:layout-probe','1')` 后刷新才出现）。 */
export function LayoutProbe() {
  const [enabled] = useState(() => {
    try {
      return localStorage.getItem('dsh-im:layout-probe') === '1'
    } catch {
      return false
    }
  })
  const [text, setText] = useState('layout…')
  useLayoutEffect(() => {
    if (!enabled) return
    const measure = () => {
      const rect = (selector: string): string => {
        const el = document.querySelector(selector)
        if (!el) return '∅'
        const box = el.getBoundingClientRect()
        return `${Math.round(box.top)}/${Math.round(box.height)}`
      }
      setText(`root ${rect('.dsh-im-root')} work ${rect('.work')} right ${rect('.col-right')} body ${rect('.right-body')} board ${rect('.task-board')} win ${window.innerHeight}`)
    }
    measure()
    const timer = window.setInterval(measure, 1000)
    window.addEventListener('resize', measure)
    return () => { window.clearInterval(timer); window.removeEventListener('resize', measure) }
  }, [enabled])
  if (!enabled) return null
  return <span className="layout-probe" title="布局自检（临时，localStorage dsh-im:layout-probe=0 关闭）">{text}</span>
}

export function ConsensusSection(props: { state: ConsensusState; latestFactSeq: number; messages: Thread['messages'] }) {
  const { state } = props
  const archived = state.clusters.filter((cluster) => cluster.lane === 'D')
  const archivedFacts = archived.reduce((total, cluster) => total + cluster.factIds.length, 0)
  const maxRefFactSeq = Math.max(
    0,
    ...state.clusters.flatMap((cluster) => cluster.refs.map((ref) => ref.factEventSeq)),
    ...state.derived.flatMap((cluster) => cluster.refs.map((ref) => ref.factEventSeq)),
  )
  const stale = props.latestFactSeq > maxRefFactSeq
  /** 版本号只展示尾段指纹（`consensus-v1:5f7c813c` → `5f7c813c`）。 */
  const versionLabel = (() => {
    const clean = state.version.split(':').filter((part) => part && !part.includes('-')).at(-1) ?? state.version
    return clean.slice(0, 8)
  })()
  const sourceOf = (refs: { factEventSeq: number; sourceMessageSeq?: number | null }[]): { seqs: number[]; title: string } => {
    const seqs = [...new Set(refs.map((ref) => ref.sourceMessageSeq).filter((seq): seq is number => typeof seq === 'number'))]
    if (seqs.length === 0) return { seqs, title: '旧数据：提取时没有记录来源消息，无法回溯' }
    const title = seqs.map((seq) => {
      const message = props.messages.find((item) => item.seq === seq)
      return message
        ? `#${seq} ${message.authorName}：${stripLegacyReasoning(message.text).replace(/\s+/g, ' ').slice(0, 60)}`
        : `#${seq}`
    }).join('\n')
    return { seqs, title }
  }
  return (
    <div className="consensus-section">
      <div className="pane-head">
        <div className="pane-title">
          群共识
          <span className="head-count">{state.clusters.filter((cluster) => cluster.lane !== 'D').length}</span>
          {stale ? <span className="pane-busy">落后于最新事实</span> : null}
        </div>
        <div className="pane-sub">
          {state.mode === 'new' ? '可回溯到原消息' : `来源缺口 ${state.provenance.missingFactIds.length} 条`}
          {' · '}版本 {versionLabel}
        </div>
      </div>
      <div className="pane-scroll">
      {(['A', 'B', 'C'] as const).map((lane) => {
        const items = state.clusters.filter((cluster) => cluster.lane === lane)
        if (items.length === 0) return null
        const ordered = [...items].sort((left, right) => consensusStatusRank(left.status) - consensusStatusRank(right.status))
        return (
          <div key={lane} className="fact-group">
            <div className="fact-kind">{CONSENSUS_LANE_TITLE[lane]} · {items.length}</div>
            {ordered.map((cluster) => {
              const source = sourceOf(cluster.refs)
              return (
                <div
                  key={cluster.key}
                  className={`fact-item${source.seqs.length ? ' clickable' : ''}`}
                  title={source.title}
                  onClick={source.seqs.length ? () => jumpToSourceMessage(source.seqs[0]) : undefined}
                >
                  <span className={`dot ${consensusDotClass(cluster.status)}`} />
                  <div className="fact-main">
                    <div className="fact-title">{cluster.text}</div>
                    <div className="fact-actions">
                      <span className={`status-pill ${cluster.status}`}>{CONSENSUS_STATUS_LABEL[cluster.status]}</span>
                      <span className="fact-meta">{cluster.kind}</span>
                      {source.seqs.length
                        ? <button type="button" className="link-btn" onClick={(event) => { event.stopPropagation(); jumpToSourceMessage(source.seqs[0]) }}>来源 #{source.seqs[0]}</button>
                        : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
      {state.derived.length > 0 && (
        <div className="fact-group">
          <div className="fact-kind">派生任务 · {state.derived.length}</div>
          {state.derived.map((cluster) => {
            const source = sourceOf(cluster.refs)
            return (
              <div
                key={cluster.key}
                className={`fact-item${source.seqs.length ? ' clickable' : ''}`}
                title={source.title}
                onClick={source.seqs.length ? () => jumpToSourceMessage(source.seqs[0]) : undefined}
              >
                <span className="dot run" />
                <div className="fact-main">
                  <div className="fact-title">{cluster.text}</div>
                  <div className="fact-actions">
                    <span className="status-pill derived">派生任务</span>
                    {source.seqs.length
                      ? <button type="button" className="link-btn" onClick={(event) => { event.stopPropagation(); jumpToSourceMessage(source.seqs[0]) }}>来源 #{source.seqs[0]}</button>
                      : null}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {archivedFacts > 0 && (
        <div className="plan-foot">已归档 {archivedFacts} 条环境/能力自述（不进 prompt）</div>
      )}
      </div>
    </div>
  )
}

/** 任务板：上方群事实（即时），下方群共识（自动生成，允许延迟于事实）。 */
export function FactsBoard(props: {
  im: ImService
  thread: Thread
  run: (fn: () => Promise<unknown> | unknown) => Promise<void>
}) {
  const facts = props.im.factsFor(props.thread.id)
  const groups = FACT_ORDER
    .map((kind) => ({ kind, items: facts.filter((fact) => fact.kind === kind) }))
    .filter((group) => group.items.length > 0)
  const consensus = props.im.consensusEnabled ? props.thread.consensusState : undefined
  const extractionPending = props.im.extractionPending(props.thread.id)
  const consensusPending = props.im.consensusPending(props.thread.id)
  const latestFactSeq = facts.reduce((max, fact) => Math.max(max, fact.seq), 0)
  return (
    <div className="plan facts task-board">
      <h2>任务板 <LayoutProbe /></h2>
      <div className="task-pane facts-pane">
      <div className="pane-head">
        <div className="pane-title">
          群事实
          <span className="head-count">{facts.length}</span>
          {extractionPending ? <span className="pane-busy">正在抽取…</span> : null}
        </div>
        <div className="pane-sub">即时投影；点「完成归档」后不再注入 prompt</div>
      </div>
      <div className="pane-scroll">
      {facts.length === 0 ? (
        <div className="pane-empty">
          {extractionPending
            ? '正在抽取群事实…（后台模型调用，通常 20–30 秒，完成后自动刷新）'
            : '还没有提取到事实。讨论里出现决定 / 待办 / 承诺后会自动出现在这里。'}
        </div>
      ) : groups.map((group) => (
        <div key={group.kind} className="fact-group">
          <div className="fact-kind">{FACT_KIND_LABEL[group.kind]}</div>
          {group.items.map((fact) => {
            const seq = fact.sourceMessageSeq
            const sourceMessage = typeof seq === 'number' ? props.thread.messages.find((item) => item.seq === seq) : undefined
            const sourceTitle = typeof seq === 'number'
              ? (sourceMessage
                ? `来源 #${seq} ${sourceMessage.authorName}：${stripLegacyReasoning(sourceMessage.text).replace(/\s+/g, ' ').slice(0, 60)}`
                : `来源 #${seq}`)
              : '旧数据：提取时没有记录来源消息，无法回溯'
            return (
              <div
                key={fact.factId}
                className={`fact-item${typeof seq === 'number' ? ' clickable' : ''}`}
                title={sourceTitle}
                onClick={typeof seq === 'number' ? () => jumpToSourceMessage(seq) : undefined}
              >
                <span className={`dot ${fact.source === 'user' ? 'run' : ''}`} />
                <div className="fact-main">
                  <div className="fact-title">{fact.owner ? <b>{fact.owner}：</b> : null}{fact.text}</div>
                  <div className="fact-actions">
                    {typeof seq === 'number'
                      ? <button type="button" className="link-btn" onClick={(event) => { event.stopPropagation(); jumpToSourceMessage(seq) }}>来源 #{seq}</button>
                      : <span className="fact-meta">旧数据不可回溯</span>}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={(event) => { event.stopPropagation(); void props.run(() => props.im.completeFact(props.thread.id, fact.factId)) }}
                    >
                      完成归档
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ))}
      </div>
      </div>
      <div className="task-pane consensus-pane">
        {!props.im.consensusEnabled ? (
          <div className="pane-empty">群共识已关闭（回滚开关 dsh-im:consensus=off）。</div>
        ) : consensus ? (
          <ConsensusSection state={consensus} latestFactSeq={latestFactSeq} messages={props.thread.messages} />
        ) : facts.length === 0 ? (
          <div className="pane-empty">
            {extractionPending ? '正在抽取群事实…抽完会自动整理群共识。' : '还没有群事实，暂不需要生成群共识。'}
          </div>
        ) : (
          <div className="pane-empty">
            {consensusPending ? '正在整理群共识…（基于现有事实，完成后自动刷新）' : '群共识正在生成…'}
            {props.thread.consensusError ? <span className="pane-error"> 上次失败：{props.thread.consensusError}（自动重试）</span> : null}
          </div>
        )}
      </div>
    </div>
  )
}

export function MemberPane(props: {
  im: ImService
  thread: Thread
  refresh: () => void
  onShowProfile: (id: string) => void
  onShowActivity: (personaId: string) => void
}) {
  const { im, thread, refresh, onShowProfile, onShowActivity } = props
  const [mq, setMq] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const visible = thread.members.filter((m) => {
    const p = im.state.personas.find((x) => x.id === m.personaId)
    return !mq || p?.name.includes(mq)
  })

  return (
    <div className="pane-members" onClick={() => setMenuFor(null)}>
      <div className="member-head">
        <h3>群成员 <span className="head-count">{thread.memberIds.length + 1}</span></h3>
        <div className="head-icons">
          <button type="button" className="icon-btn" aria-label="搜索成员" onClick={(e) => { e.stopPropagation(); setShowSearch((v) => !v) }}>
            <IconSearch size={14} />
          </button>
        </div>
      </div>
      {showSearch && (
        <input className="search member-search" placeholder="搜索成员" value={mq} onChange={(e) => setMq(e.target.value)} />
      )}
      <div className="mcard-wrap">
        <div className="mcard static">
          <div className="avatar a3">你</div>
          <div className="mbody">
            <div className="mname"><span>你</span><span className="role">群主</span></div>
            <div className="msub">方案负责人</div>
            <div className="msub">管理群成员与评审流程</div>
          </div>
        </div>
        <span className="crown" aria-label="群主"><IconCrown size={12} /></span>
      </div>
      {visible.map((m) => {
        const p = im.state.personas.find((x) => x.id === m.personaId)
        if (!p) return null
        const chips = memberChips(thread, m)
        const traces = (thread.traces ?? []).filter((trace) => trace.personaId === m.personaId)
        const lastTrace = traces.at(-1)
        const lastTool = lastTrace?.steps.filter((step) => step.kind === 'tool').at(-1)
        const running = thread.speakingPersonaId === m.personaId
        const actionText = running
          ? '正在执行…'
          : lastTool
            ? `最近：${traceToolLabel(lastTool.name)}${lastTool.ok === false ? '（失败）' : ''}`
            : undefined
        return (
          <div key={m.personaId} className="mcard-wrap">
            <div
              className="mcard"
              role="button"
              tabIndex={0}
              onClick={() => onShowProfile(m.personaId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onShowProfile(m.personaId)
                }
              }}
            >
              <Avatar persona={p} index={thread.members.indexOf(m)} />
              <div className="mbody">
                <div className="mname">
                  <span>{p.name}</span>
                  {p.post ? <em className="kind">{p.post}</em> : null}
                </div>
                <div className="msub">{p.duties.join(' · ')}</div>
                {actionText ? (
                  <div
                    className="msub member-action"
                    title={(lastTrace?.steps ?? []).filter((step) => step.kind === 'tool').slice(-3).map((step) => `${traceToolLabel(step.name)}：${step.args ?? ''}`).join('\n')}
                  >
                    <span>{actionText}</span>
                    <button
                      type="button"
                      className="text-link"
                      onClick={(event) => { event.stopPropagation(); onShowActivity(m.personaId) }}
                    >
                      执行记录
                    </button>
                  </div>
                ) : null}
                {chips.length > 0 && (
                  <div className="chips">
                    {chips.map((c) => <span key={c.text} className={`chip ${c.kind}`}>{c.text}</span>)}
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              className="icon-btn more"
              aria-label={`${p.name} 设置`}
              onClick={(e) => {
                e.stopPropagation()
                setMenuFor(menuFor === m.personaId ? null : m.personaId)
              }}
            >
              <IconMore size={14} />
            </button>
            {menuFor === m.personaId && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                {ACTIVITIES.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={m.activity === a ? 'on' : ''}
                    onClick={() => {
                      im.setActivity(thread.id, m.personaId, a)
                      setMenuFor(null)
                      refresh()
                    }}
                  >
                    {activityLabel(a)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export type GroupRightTab = 'members' | 'facts' | 'queue' | 'activity' | 'files'

export const TOOL_TRACE_LABEL: Record<string, string> = {
  list_dir: '列目录',
  read_file: '读文件',
  search_files: '搜索',
  write_file: '写群文件',
  run_check: '跑检查',
}

export function traceToolLabel(name: string | undefined): string {
  if (!name) return '执行'
  if (name.startsWith('bcdp_')) return '浏览器'
  if (name.startsWith('mcp__magpie-image__')) return '画图'
  return TOOL_TRACE_LABEL[name] ?? name
}

/** 右栏「执行」Tab：按轮列出成员的工具执行轨迹；可按成员筛选。 */
export function ActivityPane(props: {
  im: ImService
  thread: Thread
  filter: string | undefined
  onFilter: (personaId: string | undefined) => void
  onOpenTrace: (trace: TurnTrace) => void
}) {
  const { im, thread, filter, onFilter, onOpenTrace } = props
  const traces = [...(thread.traces ?? [])].reverse().filter((trace) => !filter || trace.personaId === filter)
  const members = thread.members
    .map((member) => im.state.personas.find((persona) => persona.id === member.personaId))
    .filter((persona): persona is NonNullable<typeof persona> => Boolean(persona))
  return (
    <div className="pane-activity">
      <div className="activity-filters">
        <button type="button" className={filter ? '' : 'on'} onClick={() => onFilter(undefined)}>全部</button>
        {members.map((persona) => (
          <button key={persona.id} type="button" className={filter === persona.id ? 'on' : ''} onClick={() => onFilter(persona.id)}>
            {persona.name}
          </button>
        ))}
      </div>
      {traces.length === 0 ? (
        <div className="plan-foot">还没有执行记录。角色调用工具（读文件/搜索/跑检查）后会出现在这里。</div>
      ) : null}
      {traces.map((trace) => {
        const tools = trace.steps.filter((step) => step.kind === 'tool')
        return (
          <button key={trace.id} type="button" className="trace-row" onClick={() => onOpenTrace(trace)}>
            <span className={`dot ${tools.some((step) => step.ok === false) ? 'err' : 'done'}`} />
            <span className="trace-main">
              <span className="trace-title">{trace.personaName} · {tools.length ? `${tools.length} 次工具` : '直接回复'}</span>
              <span className="trace-sub">
                {fmt(trace.at)} · {Math.max(1, Math.round(trace.ms / 1000))}s
                {tools.length ? ` · ${tools.map((step) => traceToolLabel(step.name)).slice(0, 3).join('、')}` : ''}
              </span>
            </span>
            <span className="trace-arrow"><IconChevronRight size={12} /></span>
          </button>
        )
      })}
    </div>
  )
}

/** 群的右栏：群成员 / 任务板 / 候选队列（B 方案：不再占聊天流）。 */
export function GroupRightPane(props: {
  im: ImService
  thread: Thread
  run: (fn: () => Promise<unknown> | unknown) => Promise<void>
  refresh: () => void
  onShowProfile: (id: string) => void
  tab: GroupRightTab
  onTab: (tab: GroupRightTab) => void
  activityFilter: string | undefined
  onActivityFilter: (personaId: string | undefined) => void
  onOpenTrace: (trace: TurnTrace) => void
}) {
  const { im, thread, run, refresh, onShowProfile, tab, onTab, activityFilter, onActivityFilter, onOpenTrace } = props
  return (
    <aside className="col-right">
      <div className="right-tabs">
        <button type="button" className={tab === 'members' ? 'on' : ''} onClick={() => onTab('members')}>成员</button>
        <button type="button" className={tab === 'facts' ? 'on' : ''} onClick={() => onTab('facts')}>任务板</button>
        <button type="button" className={tab === 'queue' ? 'on' : ''} onClick={() => onTab('queue')}>候选</button>
        <button type="button" className={tab === 'activity' ? 'on' : ''} onClick={() => onTab('activity')}>执行</button>
        <button type="button" className={tab === 'files' ? 'on' : ''} onClick={() => onTab('files')}>文件</button>
      </div>
      <div className="right-body">
        {tab === 'members'
          ? (
            <MemberPane
              im={im}
              thread={thread}
              refresh={refresh}
              onShowProfile={onShowProfile}
              onShowActivity={(personaId) => { onActivityFilter(personaId); onTab('activity') }}
            />
          )
          : tab === 'facts'
            ? <FactsBoard im={im} thread={thread} run={run} />
            : tab === 'queue'
              ? <RoundPlan im={im} thread={thread} />
              : tab === 'files'
                ? <GroupFilesPane thread={thread} projectRoot={thread.projectRoot} />
                : (
                  <ActivityPane
                    im={im}
                    thread={thread}
                    filter={activityFilter}
                    onFilter={onActivityFilter}
                    onOpenTrace={onOpenTrace}
                  />
                )}
      </div>
    </aside>
  )
}

/** 窄窗口（B 方案自动降级到 A）：右栏收进抽屉，顶部留一行入口。 */

