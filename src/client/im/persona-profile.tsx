/** 右栏（私聊）角色资料：模型 / 职责 / 主动私聊频率 / 可用工具 / 会话操作。 */
import { useState } from 'react'
import type { ImService } from '../../core/im.ts'
import type { ModelCatalog } from '../../host/models.ts'
import { findModel } from '../../host/models.ts'
import { labelForGrant } from '../../core/tools.ts'
import type { Activity, Persona, Thread } from '../../core/types.ts'
import { Avatar } from '../Avatar.tsx'
import { activityLabel } from '../../core/floor.ts'
import { toolGroupsSnapshot } from '../httpStore.ts'
import { ACTIVITIES } from './shared.tsx'
import { IconChevronRight, IconClose } from './icons.tsx'
import { useWorkspaces, WorkspacePicker } from './workspaces.tsx'

export function PersonaProfile(props: {
  im: ImService
  persona: Persona
  thread?: Thread
  onClose: () => void
  onEdit: () => void
  onMessage: () => void
  onDelete: () => void
  refresh: () => void
  projectRoot: string
  models: ModelCatalog
}) {
  const { im, persona, thread, onClose, onEdit, onMessage, onDelete, refresh, projectRoot, models } = props
  const workspaces = useWorkspaces()
  const [actOpen, setActOpen] = useState(false)
  const [invite, setInvite] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [root, setRoot] = useState(projectRoot)
  // 群名：只拉 1 个人是三人小窗（标题按角色名派生），拉 2 个以上才是群。
  const [groupName, setGroupName] = useState('')
  const member = thread?.members.find((m) => m.personaId === persona.id)
  const activity = member?.activity ?? persona.defaultActivity
  const muted = activity === 'muted'
  const tools = persona.toolAllow?.length
    ? persona.toolAllow.map((id) => labelForGrant(id, toolGroupsSnapshot())).join('、')
    : persona.toolDeny?.length
      ? '当前没有可用工具'
      : '继承当前主会话（可收窄）'

  function setAct(a: Activity) {
    if (member && thread) im.setActivity(thread.id, persona.id, a)
    im.updatePersona(persona.id, { defaultActivity: a })
    setActOpen(false)
    refresh()
  }

  return (
    <aside className="col-profile" onClick={() => setActOpen(false)}>
      <div className="member-head">
        <h3>角色资料</h3>
        <button className="icon-btn" aria-label="关闭资料" onClick={onClose}><IconClose size={14} /></button>
      </div>
      <div className="profile-hero">
          <Avatar persona={persona} index={im.state.personas.indexOf(persona)} size="lg" />
        <div>
          <div className="mname">{persona.name}</div>
          <div className="msub">{findModel(models, persona.model)?.label ?? persona.model}{persona.post ? ' · ' + persona.post : ''}</div>
          <div className="msub">{persona.duties.join(' · ')}</div>
          <div className="chips"><span className={`chip ${muted ? 'warn' : 'on'}`}>{activityLabel(activity)}</span></div>
        </div>
      </div>

      <div className="block">
        <h4>角色信息</h4>
        <div className="kv"><span>人设</span><b>{persona.personality}</b></div>
        <div className="kv"><span>职责</span><b>{persona.duties.join('、')}</b></div>
        <div className="kv"><span>模型</span><b>{findModel(models, persona.model)?.label ?? persona.model}</b></div>
        <div className="kv"><span>可用工具</span><b>{tools}</b></div>
      </div>

      <div className="block">
        <h4>活跃度</h4>
        <div className="mcard-wrap">
          <button type="button" className="row-btn" onClick={(e) => { e.stopPropagation(); setActOpen((v) => !v) }}>
            <span>{activityLabel(activity)}</span>
            <span><IconChevronRight size={12} /></span>
          </button>
          {actOpen && (
            <div className="menu" onClick={(e) => e.stopPropagation()}>
              {ACTIVITIES.map((a) => (
                <button key={a} type="button" className={activity === a ? 'on' : ''} onClick={() => setAct(a)}>{activityLabel(a)}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="block">
        <h4>权限与设置</h4>
        <label className="switch-row">
          <div>
            <div>禁言该成员</div>
            <small>被 @ 时才可按窗口回复</small>
          </div>
          <input
            type="checkbox"
            checked={muted}
            onChange={(e) => setAct(e.target.checked ? 'muted' : 'review')}
          />
        </label>
        <label className="switch-row">
          <div>
            <div>主动私聊</div>
            <small>允许在不宜公开时向你敲门</small>
          </div>
          <input
            type="checkbox"
            checked={persona.proactiveDm}
            onChange={(e) => {
              im.updatePersona(persona.id, { proactiveDm: e.target.checked })
              refresh()
            }}
          />
        </label>
        {persona.proactiveDm ? (
          <label className="switch-row">
            <div>
              <div>主动私聊频率</div>
              <small>克制 / 标准 / 活跃（未读不追发、评审不打扰）</small>
            </div>
            <select
              value={persona.proactiveLevel ?? 'standard'}
              onChange={(e) => {
                im.updatePersona(persona.id, { proactiveLevel: e.target.value as Persona['proactiveLevel'] })
                refresh()
              }}
            >
              <option value="low">克制</option>
              <option value="standard">标准</option>
              <option value="high">活跃</option>
            </select>
          </label>
        ) : null}
      </div>

      <div className="block">
        <h4>更多操作</h4>
        <button type="button" className="row-btn" onClick={onMessage}><span>发消息</span><span><IconChevronRight size={12} /></span></button>
        <button type="button" className="row-btn" onClick={onEdit}><span>编辑角色</span><span><IconChevronRight size={12} /></span></button>
        <button type="button" className="row-btn" onClick={() => setInvite((v) => !v)}><span>拉入群 / 小窗</span><span><IconChevronRight size={12} /></span></button>
        <button type="button" className="row-btn danger" onClick={onDelete}><span>删除角色</span><span><IconChevronRight size={12} /></span></button>
        {invite && (
          <div className="form">
            {picked.length !== 1 && (
              <label className="field">
                <span>群名</span>
                <input
                  value={groupName}
                  maxLength={40}
                  placeholder="例如：方案评审组（不填就叫「新群」）"
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </label>
            )}
            <label className="field">
              <span>关联工作区</span>
              {workspaces.length
                ? <WorkspacePicker value={root} options={workspaces} onChange={setRoot} />
                : <input value={root} onChange={(e) => setRoot(e.target.value)} />}
            </label>
            {im.state.personas.filter((p) => p.id !== persona.id).map((p) => (
              <label key={p.id} className="row">
                <input
                  type="checkbox"
                  checked={picked.includes(p.id)}
                  onChange={() => setPicked((cur) => (cur.includes(p.id) ? cur.filter((id) => id !== p.id) : [...cur, p.id]))}
                />
                {p.name}
              </label>
            ))}
            <button
              type="button"
              disabled={picked.length < 1 || !root.trim()}
              onClick={() => {
                const ids = [persona.id, ...picked]
                const project = root.trim()
                if (ids.length === 2) im.createTriad([ids[0], ids[1]], project)
                else im.createGroup(groupName, ids, project)
                setInvite(false)
                setPicked([])
                setGroupName('')
                setRoot(projectRoot)
                refresh()
              }}
            >
              确定
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}


