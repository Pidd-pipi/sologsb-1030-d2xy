import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  Grid,
  Heading,
  IconButton,
  Progress,
  ScrollArea,
  Select,
  Separator,
  Switch,
  Tabs,
  Text,
  TextArea,
  TextField,
  Theme,
  Tooltip
} from '@radix-ui/themes';
import { LEASE_TTL_MS, newSessionId, useEditLease } from './collaboration';
import { buildVersionOptions, diffVersions } from './diff';
import { useChecklistStore } from './store';
import type { ChecklistItem, ChecklistProject, ConflictReason, IssueLevel, ItemConflict, ValidationIssue, WorkflowStatus } from './types';
import { validateProject } from './validation';

const statusMeta: Record<WorkflowStatus, { label: string; color: 'gray' | 'amber' | 'green'; description: string }> = {
  draft: { label: '编辑中', color: 'gray', description: '内容可修改，完成校验后提交复核。' },
  review: { label: '复核中', color: 'amber', description: '内容已锁定，复核人确认后冻结发布。' },
  frozen: { label: '已冻结', color: 'green', description: '只读发布版本；需要修改时创建新修订。' }
};

const issueMeta: Record<IssueLevel, { color: 'red' | 'amber' | 'blue'; label: string }> = {
  error: { color: 'red', label: '阻断' },
  warning: { color: 'amber', label: '警告' },
  info: { color: 'blue', label: '提示' }
};

const conflictReasonMeta: Record<ConflictReason, { label: string; color: 'red' | 'amber' }> = {
  'both-edited': { label: '两页都改过', color: 'red' },
  'remote-deleted': { label: '他页已删除', color: 'amber' },
  'local-deleted': { label: '本页已删除', color: 'amber' },
  order: { label: '两页都调过顺序', color: 'red' }
};

const saveStatusTone: Record<string, 'green' | 'amber' | 'red' | 'blue'> = {
  saved: 'green',
  uptodate: 'blue',
  merged: 'green',
  synced: 'blue',
  conflicts: 'red',
  readonly: 'amber',
  'lease-lost': 'red',
  blocked: 'red'
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function App() {
  // 租约身份：sessionId 在页面生命周期内稳定，leaseHolderIdRef 同步给 store 做写入校验。
  const sessionIdRef = useRef(newSessionId());
  const leaseHolderIdRef = useRef<string | null>(null);
  const store = useChecklistStore({ sessionIdRef, leaseHolderIdRef });
  const project = store.selectedProject;
  // 记录本页在每个项目上是否曾持有过租约（失租后该项目才应显示"重新确认"语义）。
  const heldProjectRef = useRef<string | null>(null);
  const lease = useEditLease(project.id, heldProjectRef.current === project.id);

  const writable = lease.role === 'holder' && project.status === 'draft';
  const pendingEdits = store.pendingEdits();
  if (lease.role === 'holder') {
    heldProjectRef.current = project.id;
    leaseHolderIdRef.current = lease.lease?.holderId ?? sessionIdRef.current;
  } else {
    leaseHolderIdRef.current = null;
  }

  // 租约重新到手：仅当本页确实带着失租期间未落盘的修改时，才核对版本并合并（重新确认）。
  // 干净的查看页已由 storage 监听自动跟进最新版本，首次获取租约也不需要重新确认。
  const wasHolderRef = useRef(false);
  useEffect(() => {
    if (lease.role === 'holder') {
      if (!wasHolderRef.current && heldProjectRef.current === project.id && store.pendingEdits()) {
        store.reconcileOnLease();
      }
      wasHolderRef.current = true;
      leaseHolderIdRef.current = lease.lease?.holderId ?? sessionIdRef.current;
    } else {
      wasHolderRef.current = false;
    }
  }, [lease.role, project.id, store]);

  const [appearance, setAppearance] = useState<'light' | 'dark'>(() => (localStorage.getItem('sologsb-1030-theme') === 'dark' ? 'dark' : 'light'));
  const [search, setSearch] = useState('');
  const [selectedItemId, setSelectedItemId] = useState(project.items[0]?.id ?? '');
  const [quickStageId, setQuickStageId] = useState(project.stages[0]?.id ?? '');
  const [newChallenge, setNewChallenge] = useState('');
  const [newResponse, setNewResponse] = useState('');
  const [activeTab, setActiveTab] = useState('editor');
  const [showHelp, setShowHelp] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [freezeNote, setFreezeNote] = useState('');
  const [leftVersion, setLeftVersion] = useState('current');
  const [rightVersion, setRightVersion] = useState(project.revisions[0]?.id ?? '');
  const [savePulse, setSavePulse] = useState(false);
  const challengeRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const issues = useMemo(() => validateProject(project), [project]);
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warning').length;
  const selectedItem = project.items.find((item) => item.id === selectedItemId);
  const versionOptions = useMemo(() => buildVersionOptions(project), [project]);
  const diffEntries = useMemo(() => diffVersions(project, leftVersion, rightVersion), [project, leftVersion, rightVersion]);
  const filteredStages = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-CN');
    return project.stages
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((stage) => ({
        stage,
        items: project.items
          .filter((item) => item.stageId === stage.id)
          .filter((item) => !query || [stage.name, stage.description, item.challenge, item.response, item.abnormalProcedure].some((value) => value.toLocaleLowerCase('zh-CN').includes(query)))
          .sort((a, b) => a.order - b.order)
      }))
      .filter((group) => !query || group.items.length > 0 || group.stage.name.toLocaleLowerCase('zh-CN').includes(query));
  }, [project, search]);

  useEffect(() => {
    if (!project.items.some((item) => item.id === selectedItemId)) setSelectedItemId(project.items[0]?.id ?? '');
    if (!project.stages.some((stage) => stage.id === quickStageId)) setQuickStageId(project.stages[0]?.id ?? '');
    if (!versionOptions.some((option) => option.id === leftVersion)) setLeftVersion('current');
    if (!versionOptions.some((option) => option.id === rightVersion)) setRightVersion(versionOptions[1]?.id ?? '');
  }, [project.id, project.items, project.stages, project.revision, selectedItemId, quickStageId, versionOptions, leftVersion, rightVersion]);

  useEffect(() => {
    localStorage.setItem('sologsb-1030-theme', appearance);
  }, [appearance]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, [contenteditable="true"]') ?? false;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? store.redo() : store.undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        store.saveNow();
        setSavePulse(true);
        window.setTimeout(() => setSavePulse(false), 1200);
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        quickAddItem();
        return;
      }
      if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && selectedItemId) {
        event.preventDefault();
        store.nudgeItem(selectedItemId, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (event.key === '/' && !typing) {
        event.preventDefault();
        challengeRef.current?.focus();
        return;
      }
      if (event.key === '?' && !typing) {
        event.preventDefault();
        setShowHelp(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function quickAddItem() {
    if (!writable || !quickStageId || !newChallenge.trim()) return;
    const id = store.addItem(quickStageId, newChallenge.trim(), newResponse.trim());
    setSelectedItemId(id);
    setNewChallenge('');
    setNewResponse('');
    challengeRef.current?.focus();
  }

  function selectIssue(issue: ValidationIssue) {
    if (issue.itemId) setSelectedItemId(issue.itemId);
    setActiveTab('editor');
    if (issue.stageId) setQuickStageId(issue.stageId);
  }

  function requestLeaseAndReconfirm(): boolean {
    const acquired = lease.request();
    leaseHolderIdRef.current = acquired ? sessionIdRef.current : null;
    if (acquired && store.pendingEdits()) store.reconcileOnLease();
    return Boolean(acquired);
  }

  function exportPrintableHtml() {
    const stageOrder = project.stages.slice().sort((a, b) => a.order - b.order);
    const body = stageOrder.map((stage) => {
      const rows = project.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).map((item) => `
        <tr><td>${item.critical ? '<strong>◆</strong> ' : ''}${escapeHtml(item.challenge)}</td><td>${escapeHtml(item.response || '未填写')}</td><td>${escapeHtml(item.abnormalProcedure || '—')}</td></tr>
      `).join('');
      return `<section><h2>${escapeHtml(stage.name)}</h2><p>${escapeHtml(stage.description)}</p><table><thead><tr><th>挑战语</th><th>预期回应</th><th>异常处置</th></tr></thead><tbody>${rows || '<tr><td colspan="3">本阶段暂无项目</td></tr>'}</tbody></table></section>`;
    }).join('');
    const documentHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(project.name)}</title><style>
      body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;margin:36px}
      h1{margin:0 0 4px} .meta{color:#666;margin-bottom:28px} h2{border-bottom:2px solid #222;padding-bottom:5px;margin-top:26px}
      table{width:100%;border-collapse:collapse} th,td{border:1px solid #bbb;padding:7px;text-align:left;vertical-align:top} th{background:#eee}
      @media print{body{margin:15mm}section{break-inside:avoid}}
    </style></head><body><h1>${escapeHtml(project.name)}</h1><div class="meta">${escapeHtml(project.aircraft)} · r${project.revision} · ${escapeHtml(statusMeta[project.status].label)} · 导出 ${new Date().toLocaleString('zh-CN')}</div>${body}</body></html>`;
    const url = URL.createObjectURL(new Blob([documentHtml], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.name.replace(/[^\p{L}\p{N}-]+/gu, '-')}-r${project.revision}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function togglePrecondition(item: ChecklistItem, preconditionId: string) {
    const ids = new Set(item.preconditionIds);
    ids.has(preconditionId) ? ids.delete(preconditionId) : ids.add(preconditionId);
    store.updateItem(item.id, { preconditionIds: [...ids] });
  }

  function duplicateItem(item: ChecklistItem) {
    const id = store.addItem(item.stageId, `${item.challenge} - COPY`, item.response);
    window.setTimeout(() => {
      store.updateItem(id, {
        critical: item.critical,
        preconditionIds: [...item.preconditionIds],
        abnormalProcedure: item.abnormalProcedure
      });
      setSelectedItemId(id);
    }, 0);
  }

  const reachabilityErrors = issues.filter((issue) => issue.type === 'unreachable-precondition' && issue.level === 'error').length;
  const submitDisabled = !writable || errors > 0 || project.conflicts.length > 0 || project.orderCheckPending;
  const freezeDisabled = project.status === 'review' && (errors > 0 || project.conflicts.length > 0 || project.orderCheckPending);
  const submitBlockReason = project.conflicts.length > 0
    ? `有 ${project.conflicts.length} 个两页同改检查项待人工处理`
    : project.orderCheckPending
      ? '顺序变化后前置条件可达性未重新核对'
      : errors > 0 ? `存在 ${errors} 个阻断问题` : '';

  return (
    <Theme appearance={appearance} accentColor="blue" grayColor="slate" radius="large" scaling="100%">
      <div className="app-frame">
        <LeaseBar
          role={lease.role}
          leaseName={lease.lease?.holderName ?? ''}
          editorName={lease.lease?.holderId === sessionIdRef.current ? lease.lease.holderName : ''}
          ttlSeconds={lease.ttlSeconds}
          pending={pendingEdits}
          onRequest={requestLeaseAndReconfirm}
          onRelease={lease.release}
          onRename={lease.setHolderName}
        />
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">FL</div>
            <div><Heading size="5">Flightline</Heading><Text size="1" color="gray">飞行检查单编写与校验</Text></div>
          </div>
          <div className="project-switcher">
            <Select.Root value={project.id} onValueChange={store.selectProject}>
              <Select.Trigger aria-label="选择检查单项目" variant="soft" />
              <Select.Content position="popper">
                {store.state.projects.map((entry) => <Select.Item key={entry.id} value={entry.id}>{entry.name}</Select.Item>)}
              </Select.Content>
            </Select.Root>
            <Button variant="soft" onClick={store.addProject}>新建项目</Button>
          </div>
          <div className="top-actions">
            <TextField.Root ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索检查项 / Ctrl+K" style={{ minWidth: 220 }}>
              <TextField.Slot>⌕</TextField.Slot>
            </TextField.Root>
            <Tooltip content="撤销 Ctrl/⌘+Z"><Button variant="soft" disabled={!writable || !store.canUndo} onClick={store.undo}>撤销</Button></Tooltip>
            <Tooltip content="重做 Shift+Ctrl/⌘+Z"><Button variant="soft" disabled={!writable || !store.canRedo} onClick={store.redo}>重做</Button></Tooltip>
            <Tooltip content={writable ? '手动保存 Ctrl/⌘+S' : '只读页面：刷新为最新版本'}><Button variant="soft" onClick={() => { store.saveNow(); setSavePulse(true); window.setTimeout(() => setSavePulse(false), 1200); }}>{savePulse ? '已保存' : writable ? '保存' : '刷新同步'}</Button></Tooltip>
            <Tooltip content="切换外观"><IconButton variant="soft" aria-label="切换明暗主题" onClick={() => setAppearance(appearance === 'light' ? 'dark' : 'light')}>{appearance === 'light' ? '◐' : '☀'}</IconButton></Tooltip>
            <Tooltip content="键盘帮助"><IconButton variant="soft" aria-label="键盘帮助" onClick={() => setShowHelp(true)}>?</IconButton></Tooltip>
          </div>
        </header>

        {store.saveResult && (
          <div className="save-toast">
            <Callout.Root color={saveStatusTone[store.saveResult.status] ?? 'blue'}>
              <Callout.Text>
                <strong>{saveResultLabel(store.saveResult.status)}</strong>{store.saveResult.detail ? ` · ${store.saveResult.detail}` : ''}
              </Callout.Text>
            </Callout.Root>
          </div>
        )}

        <div className="workflow-bar">
          <div className="workflow-steps">
            {(['draft', 'review', 'frozen'] as WorkflowStatus[]).map((status, index) => (
              <div key={status} className={`workflow-step ${project.status === status ? 'active' : ''} ${status === 'draft' || project.revision > 1 ? 'done' : ''}`}>
                <span>{index + 1}</span><div><strong>{statusMeta[status].label}</strong><small>{statusMeta[status].description}</small></div>
              </div>
            ))}
          </div>
          <Flex gap="2" align="center" wrap="wrap">
            <Badge color={statusMeta[project.status].color} size="2">r{project.revision} · {statusMeta[project.status].label} · v{project.contentVersion}</Badge>
            <Text size="1" color="gray">{errors ? `${errors} 个阻断` : '无阻断问题'} · {warnings} 个警告</Text>
            {project.status === 'draft' && (
              <Tooltip content={submitBlockReason || '提交后进入复核'}>
                <Button color="amber" onClick={store.submitForReview} disabled={submitDisabled}>提交复核</Button>
              </Tooltip>
            )}
            {project.status === 'review' && <Button color="green" onClick={() => setFreezeOpen(true)} disabled={freezeDisabled}>复核通过并冻结</Button>}
            {project.status === 'frozen' && <Button onClick={store.createRevision} disabled={lease.role !== 'holder'}>创建修订 r{project.revision + 1}</Button>}
            <Button variant="soft" onClick={() => setShowPreview(true)}>只读预览</Button>
            <Button variant="soft" onClick={() => window.print()}>打印</Button>
            <Button variant="soft" onClick={exportPrintableHtml}>导出打印版</Button>
          </Flex>
        </div>

        <main className="workspace">
          <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
            <Tabs.List className="main-tabs">
              <Tabs.Trigger value="editor">编辑清单</Tabs.Trigger>
              <Tabs.Trigger value="conflicts">并发冲突{project.conflicts.length > 0 && <Badge color="red" size="1" variant="soft" ml="1">{project.conflicts.length}</Badge>}</Tabs.Trigger>
              <Tabs.Trigger value="versions">版本差异 <Badge size="1" variant="soft">{project.revisions.length}</Badge></Tabs.Trigger>
              <Tabs.Trigger value="print">打印预览</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="editor">
              <div className="editor-grid">
                <aside className="stage-sidebar">
                  <Flex justify="between" align="center" mb="3">
                    <Heading size="3">飞行阶段</Heading>
                    <Button size="1" variant="soft" disabled={!writable} onClick={store.addStage}>＋阶段</Button>
                  </Flex>
                  <ScrollArea type="auto" scrollbars="vertical" style={{ height: 'calc(100vh - 250px)' }}>
                    <div className="stage-nav">
                      {project.stages.slice().sort((a, b) => a.order - b.order).map((stage, index) => {
                        const count = project.items.filter((item) => item.stageId === stage.id).length;
                        const issueCount = issues.filter((issue) => issue.stageId === stage.id).length;
                        return (
                          <button key={stage.id} className={`stage-nav-item ${quickStageId === stage.id ? 'active' : ''}`} onClick={() => setQuickStageId(stage.id)}>
                            <span className="stage-index">{String(index + 1).padStart(2, '0')}</span>
                            <span><strong>{stage.name}</strong><small>{count} 项{issueCount ? ` · ${issueCount} 个问题` : ''}</small></span>
                          </button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                  <Card className="project-card">
                    <Text size="1" color="gray">项目资料</Text>
                    <label><span>检查单名称</span><TextField.Root value={project.name} disabled={!writable} onChange={(event) => store.updateProject({ name: event.target.value })} /></label>
                    <label><span>机型 / 注册号</span><TextField.Root value={project.aircraft} disabled={!writable} onChange={(event) => store.updateProject({ aircraft: event.target.value })} /></label>
                  </Card>
                </aside>

                <section className="checklist-main">
                  <div className="list-heading">
                    <div><Heading size="6">{project.name}</Heading><Text color="gray">{project.aircraft} · {project.items.length} 个检查项 · {project.stages.length} 个阶段</Text></div>
                    <Flex gap="2" align="center">
                      {project.conflicts.length > 0 && <Badge color="red" size="2">{project.conflicts.length} 项待人工处理</Badge>}
                      <Badge color={project.status === 'draft' ? 'gray' : project.status === 'review' ? 'amber' : 'green'}>{statusMeta[project.status].label}</Badge>
                    </Flex>
                  </div>
                  {lease.role !== 'holder' && (
                    <Callout.Root color={lease.role === 'stale' ? 'red' : 'amber'} mb="4">
                      <Callout.Text>
                        {lease.role === 'other'
                          ? '编辑租约由另一页面持有，本页为只读视图；对方释放租约后可申请接管。'
                          : '本页持有的租约已失效，当前只能查看并重新确认。请在页面顶部的租约栏重新获得租约，系统会核对版本并合并本页未保存的修改。'}
                      </Callout.Text>
                    </Callout.Root>
                  )}
                  {project.conflicts.length > 0 && (
                    <Callout.Root color="red" mb="4">
                      <Flex justify="between" align="center" gap="3" wrap="wrap">
                        <Callout.Text>同一检查项被两个页面修改，已按“互不覆盖”挂起。人工处理完成前不能提交复核或冻结。</Callout.Text>
                        <Button size="2" color="red" variant="soft" onClick={() => setActiveTab('conflicts')}>前往处理（{project.conflicts.length}）</Button>
                      </Flex>
                    </Callout.Root>
                  )}
                  {project.orderCheckPending && (
                    <Callout.Root color="amber" mb="4">
                      <Flex justify="between" align="center" gap="3" wrap="wrap">
                        <Callout.Text>
                          检查项顺序已变化，前置条件可达性需要重新算出。{reachabilityErrors > 0 ? `当前有 ${reachabilityErrors} 个不可达前置条件。` : '未重新核对前不能提交复核或冻结。'}
                        </Callout.Text>
                        <Button size="2" color="amber" variant="soft" disabled={!writable} onClick={store.recheckReachability}>
                          {writable ? '重新核对可达性' : '仅持租约页面可核对'}
                        </Button>
                      </Flex>
                    </Callout.Root>
                  )}
                  {project.status !== 'draft' && <Callout.Root color={project.status === 'review' ? 'amber' : 'green'} mb="4"><Callout.Text>{statusMeta[project.status].description} 当前内容不能直接编辑。</Callout.Text></Callout.Root>}

                  <div className="quick-entry">
                    <Select.Root value={quickStageId || undefined} onValueChange={setQuickStageId} disabled={!writable}>
                      <Select.Trigger variant="soft" aria-label="新检查项所属阶段" />
                      <Select.Content position="popper">{project.stages.map((stage) => <Select.Item key={stage.id} value={stage.id}>{stage.name}</Select.Item>)}</Select.Content>
                    </Select.Root>
                    <TextField.Root ref={challengeRef} value={newChallenge} disabled={!writable} placeholder="挑战语，如 起飞构型（按 / 聚焦）" onChange={(event) => setNewChallenge(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) quickAddItem(); }} />
                    <TextField.Root value={newResponse} disabled={!writable} placeholder="预期回应" onChange={(event) => setNewResponse(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) quickAddItem(); }} />
                    <Button disabled={!writable || !newChallenge.trim()} onClick={quickAddItem}>新增</Button>
                    <Text size="1" color="gray">Ctrl/⌘+Enter</Text>
                  </div>

                  <div className="stage-list">
                    {filteredStages.map(({ stage, items }, stageIndex) => (
                      <Card key={stage.id} className="stage-card">
                        <div className="stage-card-head">
                          <div className="drag-handle" title="阶段排序">⋮⋮</div>
                          <div className="stage-title">
                            <span className="sequence-chip">{stageIndex + 1}</span>
                            <input aria-label={`${stage.name} 阶段名称`} value={stage.name} disabled={!writable} onChange={(event) => store.updateStage(stage.id, { name: event.target.value })} />
                            <TextField.Root value={stage.description} disabled={!writable} onChange={(event) => store.updateStage(stage.id, { description: event.target.value })} />
                          </div>
                          <Flex gap="1">
                            <Button size="1" variant="soft" disabled={!writable || stage.order === 0} onClick={() => store.moveStage(stage.id, -1)}>上移</Button>
                            <Button size="1" variant="soft" disabled={!writable || stage.order === project.stages.length - 1} onClick={() => store.moveStage(stage.id, 1)}>下移</Button>
                            <Button size="1" color="red" variant="soft" disabled={!writable || items.length > 0} onClick={() => store.deleteStage(stage.id)}>删除</Button>
                          </Flex>
                        </div>
                        <div className="item-table">
                          {items.map((item) => {
                            const itemIssues = issues.filter((issue) => issue.itemId === item.id);
                            const inConflict = project.conflicts.some((conflict) => conflict.itemId === item.id);
                            return (
                              <article
                                key={item.id}
                                className={`checklist-row ${selectedItemId === item.id ? 'selected' : ''} ${inConflict ? 'conflict-row' : ''}`}
                                draggable={writable}
                                onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
                                onDragOver={(event) => { if (writable) event.preventDefault(); }}
                                onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData('text/plain'); if (source) store.reorderItem(source, item.id, true); }}
                                onClick={() => setSelectedItemId(item.id)}
                              >
                                <span className="drag-handle">⋮⋮</span>
                                <div className="check-item-copy">
                                  <Flex gap="2" align="center" wrap="wrap">
                                    <strong>{item.challenge || '未命名检查项'}</strong>
                                    {item.critical && <Badge color="red" size="1">关键</Badge>}
                                    {item.preconditionIds.length > 0 && <Badge color="blue" size="1">{item.preconditionIds.length} 前置</Badge>}
                                    {inConflict && <Badge color="red" size="1">两页同改 · 待处理</Badge>}
                                    {itemIssues.length > 0 && <Badge color={itemIssues.some((issue) => issue.level === 'error') ? 'red' : 'amber'} size="1">{itemIssues.length} 问题</Badge>}
                                  </Flex>
                                  <span className={`response-preview ${!item.response ? 'missing' : ''}`}>{item.response || '缺少预期回应'}</span>
                                  {item.abnormalProcedure && <small>异常：{item.abnormalProcedure}</small>}
                                </div>
                                <div className="row-actions">
                                  <Button size="1" variant="ghost" disabled={!writable} onClick={(event) => { event.stopPropagation(); store.nudgeItem(item.id, -1); }}>↑</Button>
                                  <Button size="1" variant="ghost" disabled={!writable} onClick={(event) => { event.stopPropagation(); store.nudgeItem(item.id, 1); }}>↓</Button>
                                  <Button size="1" variant="ghost" disabled={!writable} onClick={(event) => { event.stopPropagation(); duplicateItem(item); }}>复制</Button>
                                  <Button size="1" color="red" variant="ghost" disabled={!writable} onClick={(event) => { event.stopPropagation(); if (window.confirm(`删除“${item.challenge}”？`)) store.deleteItem(item.id); }}>删除</Button>
                                </div>
                              </article>
                            );
                          })}
                          {!items.length && <button className="empty-row" disabled={!writable} onClick={() => { setQuickStageId(stage.id); challengeRef.current?.focus(); }}>＋ 为本阶段新增第一个检查项</button>}
                        </div>
                      </Card>
                    ))}
                  </div>
                </section>

                <aside className="inspector">
                  <ScrollArea type="auto" scrollbars="vertical" style={{ height: 'calc(100vh - 200px)' }}>
                    <div className="inspector-inner">
                      <section>
                        <Flex justify="between" align="center" mb="3">
                          <Heading size="4">检查项详情</Heading>
                          {selectedItem && <Badge variant="soft">#{selectedItem.order + 1} · v{selectedItem.version}</Badge>}
                        </Flex>
                        {selectedItem ? (
                          <div className="inspector-form">
                            <label><span>挑战语</span><TextField.Root value={selectedItem.challenge} disabled={!writable} onChange={(event) => store.updateItem(selectedItem.id, { challenge: event.target.value })} /></label>
                            <label><span>预期回应</span><TextField.Root value={selectedItem.response} disabled={!writable} onChange={(event) => store.updateItem(selectedItem.id, { response: event.target.value })} /></label>
                            <Flex justify="between" align="center"><Text size="2" weight="bold">关键标记</Text><Switch checked={selectedItem.critical} disabled={!writable} onCheckedChange={(checked) => store.updateItem(selectedItem.id, { critical: checked })} /></Flex>
                            <label><span>异常处理</span><TextArea value={selectedItem.abnormalProcedure} disabled={!writable} onChange={(event) => store.updateItem(selectedItem.id, { abnormalProcedure: event.target.value })} placeholder="异常条件、立即动作和后续步骤" /></label>
                            <div>
                              <Text size="2" weight="bold" mb="2" as="p">前置条件</Text>
                              <div className="precondition-list">
                                {project.items.filter((item) => item.id !== selectedItem.id).sort((a, b) => a.order - b.order).map((item) => (
                                  <label key={item.id} className="check-row">
                                    <input type="checkbox" checked={selectedItem.preconditionIds.includes(item.id)} disabled={!writable} onChange={() => togglePrecondition(selectedItem, item.id)} />
                                    <span>{item.challenge || '未命名'}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                            <Text size="1" color="gray">Alt+↑/↓ 调整顺序 · 拖动左侧把手可跨阶段移动{writable ? '' : ' · 只读页面不可编辑'}</Text>
                          </div>
                        ) : <Text color="gray">从清单中选择一个检查项进行编辑。</Text>}
                      </section>
                      <Separator size="4" />
                      <section>
                        <Flex justify="between" align="center" mb="2"><Heading size="4">发布校验</Heading><Badge color={errors ? 'red' : warnings ? 'amber' : 'green'}>{errors ? '未通过' : warnings ? '需确认' : '通过'}</Badge></Flex>
                        <Progress value={issues.length ? Math.max(8, 100 - errors * 22 - warnings * 8) : 100} color={errors ? 'red' : warnings ? 'amber' : 'green'} />
                        <div className="issue-list">
                          {issues.length ? issues.map((issue) => (
                            <button key={issue.id} className={`issue-card ${issue.level}`} onClick={() => selectIssue(issue)}>
                              <Badge color={issueMeta[issue.level].color} size="1">{issueMeta[issue.level].label}</Badge>
                              <span><strong>{issue.title}</strong><small>{issue.detail}</small></span>
                            </button>
                          )) : <Callout.Root color="green"><Callout.Text>当前检查单通过全部结构与顺序校验。</Callout.Text></Callout.Root>}
                        </div>
                      </section>
                      <Separator size="4" />
                      <section>
                        <Heading size="4" mb="3">键盘操作</Heading>
                        <div className="shortcut-grid">
                          <span><kbd>/</kbd> 聚焦快速录入</span>
                          <span><kbd>⌘/Ctrl+Enter</kbd> 新增检查项</span>
                          <span><kbd>Alt+↑/↓</kbd> 移动选中项</span>
                          <span><kbd>⌘/Ctrl+Z</kbd> 撤销编辑</span>
                        </div>
                      </section>
                    </div>
                  </ScrollArea>
                </aside>
              </div>
            </Tabs.Content>

            <Tabs.Content value="conflicts">
              <ConflictPanel
                project={project}
                writable={writable}
                issues={issues}
                onResolve={store.resolveConflict}
                onRecheck={store.recheckReachability}
              />
            </Tabs.Content>

            <Tabs.Content value="versions">
              <div className="content-page">
                <Heading size="7">版本差异</Heading>
                <Text color="gray" as="p">冻结版本不可修改；创建修订后形成新的编辑中版本。</Text>
                <div className="version-controls">
                  <label><span>基准版本</span><Select.Root value={leftVersion} onValueChange={setLeftVersion}><Select.Trigger variant="soft" /><Select.Content position="popper">{versionOptions.map((option) => <Select.Item key={option.id} value={option.id}>{option.label}</Select.Item>)}</Select.Content></Select.Root></label>
                  <span className="version-arrow">→</span>
                  <label><span>比较版本</span><Select.Root value={rightVersion} onValueChange={setRightVersion}><Select.Trigger variant="soft" /><Select.Content position="popper">{versionOptions.map((option) => <Select.Item key={option.id} value={option.id}>{option.label}</Select.Item>)}</Select.Content></Select.Root></label>
                </div>
                <div className="diff-list">
                  {diffEntries.length ? diffEntries.map((entry) => (
                    <Card key={`${entry.type}-${entry.key}`} className="diff-card">
                      <Flex justify="between" align="center"><Badge color={entry.type === 'added' ? 'green' : entry.type === 'removed' ? 'red' : entry.type === 'stage' ? 'blue' : 'amber'}>{entry.type === 'added' ? '新增' : entry.type === 'removed' ? '删除' : entry.type === 'stage' ? '阶段' : '修改'}</Badge><Text size="1" color="gray">{entry.stage}</Text></Flex>
                      <Grid columns="2" gap="3" mt="3" className="diff-columns">
                        <div className="diff-before"><Text size="1" weight="bold">基准</Text><pre>{entry.before}</pre></div>
                        <div className="diff-after"><Text size="1" weight="bold">比较版本</Text><pre>{entry.after}</pre></div>
                      </Grid>
                    </Card>
                  )) : <div className="empty-page"><strong>两个版本没有差异</strong><span>选择不同版本后可查看新增、删除和修改的检查项。</span></div>}
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="print">
              <div className="content-page">
                <Flex justify="between" align="center" mb="4">
                  <div><Heading size="7">打印预览</Heading><Text color="gray" as="p">{project.name} · r{project.revision} · 只读排版</Text></div>
                  <Flex gap="2"><Button variant="soft" onClick={exportPrintableHtml}>导出 HTML</Button><Button onClick={() => window.print()}>打印 / PDF</Button></Flex>
                </Flex>
                <PrintableChecklist project={project} />
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </main>
      </div>

      <Dialog.Root open={showPreview} onOpenChange={setShowPreview}>
        <Dialog.Content maxWidth="850px" className="preview-dialog">
          <Dialog.Title>只读检查单预览</Dialog.Title>
          <Dialog.Description size="2" color="gray">{project.name} · r{project.revision} · {statusMeta[project.status].label}</Dialog.Description>
          <div className="dialog-scroll"><PrintableChecklist project={project} compact /></div>
          <Flex gap="3" justify="end" mt="4"><Dialog.Close><Button variant="soft">关闭</Button></Dialog.Close><Button onClick={() => window.print()}>打印</Button></Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={freezeOpen} onOpenChange={setFreezeOpen}>
        <Dialog.Content maxWidth="520px">
          <Dialog.Title>冻结 r{project.revision}</Dialog.Title>
          <Dialog.Description size="2" color="gray">冻结后不可直接编辑，只能通过创建新修订继续修改。</Dialog.Description>
          <TextArea mt="4" value={freezeNote} onChange={(event) => setFreezeNote(event.target.value)} placeholder="复核意见或版本说明" />
          <Flex gap="3" justify="end" mt="4"><Dialog.Close><Button variant="soft">取消</Button></Dialog.Close><Button color="green" disabled={freezeDisabled} onClick={() => { const result = store.freezeRevision(freezeNote); if (result.status !== 'blocked' && result.status !== 'readonly' && result.status !== 'lease-lost') { setFreezeOpen(false); setFreezeNote(''); } }}>确认冻结</Button></Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={showHelp} onOpenChange={setShowHelp}>
        <Dialog.Content maxWidth="560px">
          <Dialog.Title>键盘快速操作</Dialog.Title>
          <div className="help-list">
            <div><kbd>⌘/Ctrl + K</kbd><span>聚焦全局搜索</span></div>
            <div><kbd>/</kbd><span>聚焦快速录入挑战语</span></div>
            <div><kbd>⌘/Ctrl + Enter</kbd><span>新增检查项</span></div>
            <div><kbd>Alt + ↑ / ↓</kbd><span>移动当前选中检查项</span></div>
            <div><kbd>⌘/Ctrl + Z</kbd><span>撤销最近一次编辑</span></div>
            <div><kbd>⇧ + ⌘/Ctrl + Z</kbd><span>重做编辑</span></div>
            <div><kbd>⌘/Ctrl + S</kbd><span>{writable ? '保存前核对版本并写入浏览器' : '只读页：刷新同步最新版本'}</span></div>
          </div>
          <Flex justify="end" mt="4"><Dialog.Close><Button>了解了</Button></Dialog.Close></Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Theme>
  );
}

function saveResultLabel(status: string): string {
  const labels: Record<string, string> = {
    saved: '已保存',
    uptodate: '已是最新',
    merged: '已跨页合并',
    synced: '已同步最新版本',
    conflicts: '出现并发冲突',
    readonly: '当前为只读',
    'lease-lost': '租约已失效',
    blocked: '操作被阻止'
  };
  return labels[status] ?? status;
}

function LeaseBar({
  role,
  leaseName,
  ttlSeconds,
  pending,
  onRequest,
  onRelease,
  onRename
}: {
  role: 'holder' | 'other' | 'stale' | 'none';
  leaseName: string;
  editorName: string;
  ttlSeconds: number;
  pending: boolean;
  onRequest: () => boolean;
  onRelease: () => void;
  onRename: (name: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState('');
  const [denied, setDenied] = useState(false);
  const handleRequest = () => {
    const ok = onRequest();
    if (!ok) {
      setDenied(true);
      window.setTimeout(() => setDenied(false), 3000);
    }
  };
  return (
    <div className={`lease-bar ${role}`}>
      <span className="lease-dot" />
      {role === 'holder' && (
        <>
          <Text size="2" weight="bold">可写页面（持有编辑租约）</Text>
          <TextField.Root
            className="lease-name-input"
            size="1"
            value={nameDraft || leaseName}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => { if (nameDraft.trim()) { onRename(nameDraft); setNameDraft(''); } }}
            onKeyDown={(event) => { if (event.key === 'Enter') { if (nameDraft.trim()) onRename(nameDraft); setNameDraft(''); } }}
            aria-label="本页面编辑者名称"
          />
          <Text size="1" color="gray">租约 {ttlSeconds}s 后续期；其他标签页只读</Text>
          <div style={{ marginLeft: 'auto' }}>
            <Button size="1" variant="soft" onClick={onRelease}>释放租约给其他页面</Button>
          </div>
        </>
      )}
      {role === 'other' && (
        <>
          <Text size="2" weight="bold">只读：编辑租约由「{leaseName}」持有</Text>
          <Text size="1" color="gray">等待对方释放，或租约 {Math.round(LEASE_TTL_MS / 1000)} 秒无心跳后接管</Text>
          {denied && <Text size="1" color="red">租约仍被对方持有，请等待其释放或到期</Text>}
          <div style={{ marginLeft: 'auto' }}>
            <Button size="1" variant="soft" onClick={handleRequest}>申请接管并重新确认</Button>
          </div>
        </>
      )}
      {role === 'stale' && (
        <>
          <Text size="2" weight="bold">{pending ? '租约已失效：本页改动尚未保存，当前只能查看' : '租约已失效：当前只能查看'}</Text>
          <Text size="1" color="gray">重新获得租约时会先核对项目版本，再决定合并还是挂起冲突</Text>
          {denied && <Text size="1" color="red">租约仍被对方持有，请等待其释放或到期</Text>}
          <div style={{ marginLeft: 'auto' }}>
            <Button size="1" color="red" variant="solid" onClick={handleRequest}>重新确认并申请租约</Button>
          </div>
        </>
      )}
      {role === 'none' && (
        <>
          <Text size="2" weight="bold">只读预览</Text>
          <Text size="1" color="gray">当前没有活动的编辑租约</Text>
          <div style={{ marginLeft: 'auto' }}>
            <Button size="1" variant="soft" onClick={handleRequest}>申请编辑租约</Button>
          </div>
        </>
      )}
    </div>
  );
}

function itemDigest(item: ChecklistItem | null): { stage: string; lines: string[] } | null {
  if (!item) return null;
  return {
    stage: item.stageId,
    lines: [
      `#${item.order + 1} v${item.version}`,
      `挑战语：${item.challenge || '（空）'}`,
      `预期回应：${item.response || '（空）'}`,
      `关键：${item.critical ? '是' : '否'}`,
      `前置条件：${item.preconditionIds.length} 项`,
      `异常处置：${item.abnormalProcedure || '—'}`
    ]
  };
}

function ConflictPanel({
  project,
  writable,
  issues,
  onResolve,
  onRecheck
}: {
  project: ChecklistProject;
  writable: boolean;
  issues: ValidationIssue[];
  onResolve: (itemId: string, decision: 'local' | 'remote' | 'both' | 'discard') => void;
  onRecheck: () => void;
}) {
  const stageName = (stageId: string) => project.stages.find((stage) => stage.id === stageId)?.name ?? '未知阶段';
  const conflictIssues = issues.filter((issue) => project.conflicts.some((conflict) => conflict.itemId === issue.itemId));
  return (
    <div className="content-page">
      <Heading size="7">并发冲突处理</Heading>
      <Text color="gray" as="p">两个标签页修改了同一份检查单。系统按“互不覆盖”原则保留双方版本，必须由人工逐项处理；全部解决并重新核对可达性前，不能提交复核或冻结。</Text>

      {project.conflicts.length === 0 ? (
        <div className="empty-page">
          <strong>{project.orderCheckPending ? '冲突已全部处理，还差最后一步' : '当前没有待处理的并发冲突'}</strong>
          <span>{project.orderCheckPending ? '请点击下方按钮重新核对前置条件可达性。' : '同一检查项被两个页面同时修改时会在这里列出。'}</span>
          {project.orderCheckPending && (
            <Button mt="4" color="amber" disabled={!writable} onClick={onRecheck}>重新核对前置条件可达性</Button>
          )}
        </div>
      ) : (
        <div className="conflict-list">
          {project.conflicts.map((conflict: ItemConflict) => {
            const meta = conflictReasonMeta[conflict.reason];
            const local = itemDigest(conflict.localSnapshot);
            const remote = itemDigest(conflict.remoteSnapshot);
            return (
              <Card key={conflict.itemId} className="conflict-card">
                <Flex justify="between" align="center" mb="3" wrap="wrap" gap="2">
                  <Flex gap="2" align="center">
                    <Badge color={meta.color} size="2">{meta.label}</Badge>
                    <Heading size="4">{conflict.challenge || '未命名检查项'}</Heading>
                  </Flex>
                  <Text size="1" color="gray">本页：{conflict.localHolder} · 他页：{conflict.remoteHolder} · {new Date(conflict.createdAt).toLocaleTimeString('zh-CN')}</Text>
                </Flex>
                <Grid columns="2" gap="3" className="diff-columns">
                  <div className="diff-before">
                    <Text size="1" weight="bold">本页版本（{conflict.localHolder}）{local ? ` · ${stageName(local.stage)}` : ''}</Text>
                    <pre>{local ? local.lines.join('\n') : '（本页已删除该项）'}</pre>
                  </div>
                  <div className="diff-after">
                    <Text size="1" weight="bold">他页版本（{conflict.remoteHolder}）{remote ? ` · ${stageName(remote.stage)}` : ''}</Text>
                    <pre>{remote ? remote.lines.join('\n') : '（他页已删除该项）'}</pre>
                  </div>
                </Grid>
                <Flex gap="2" mt="3" wrap="wrap">
                  <Button size="2" color="blue" variant="soft" disabled={!writable || !conflict.localSnapshot} onClick={() => onResolve(conflict.itemId, 'local')}>采用本页版本</Button>
                  <Button size="2" color="green" variant="soft" disabled={!writable || !conflict.remoteSnapshot} onClick={() => onResolve(conflict.itemId, 'remote')}>采用他页版本</Button>
                  <Button size="2" variant="soft" disabled={!writable || !conflict.localSnapshot || !conflict.remoteSnapshot} onClick={() => onResolve(conflict.itemId, 'both')}>两项都保留</Button>
                  <Button size="2" color="red" variant="ghost" disabled={!writable} onClick={() => onResolve(conflict.itemId, 'discard')}>丢弃（删除该项）</Button>
                  {!writable && <Text size="1" color="amber">只读页面不能处理冲突，请先取得编辑租约。</Text>}
                </Flex>
              </Card>
            );
          })}
        </div>
      )}

      {project.orderCheckPending && project.conflicts.length === 0 && (
        <Callout.Root color="amber" mt="4">
          <Flex justify="between" align="center" gap="3" wrap="wrap">
            <Callout.Text>顺序变化后前置条件可达性尚未重新核对，未核对前不能提交复核或冻结。</Callout.Text>
            <Button color="amber" variant="soft" disabled={!writable} onClick={onRecheck}>重新核对可达性</Button>
          </Flex>
        </Callout.Root>
      )}
      {conflictIssues.length > 0 && (
        <Callout.Root color="red" mt="4">
          <Callout.Text>这些冲突检查项目前还存在 {conflictIssues.length} 个校验问题，处理冲突后请一并修正。</Callout.Text>
        </Callout.Root>
      )}
    </div>
  );
}

function PrintableChecklist({ project, compact = false }: { project: ChecklistProject; compact?: boolean }) {
  const stages = project.stages.slice().sort((a, b) => a.order - b.order);
  return (
    <article className={`print-sheet ${compact ? 'compact' : ''}`}>
      <header><div><Heading size="7">{project.name}</Heading><Text color="gray" as="p">{project.aircraft} · r{project.revision} · {statusMeta[project.status].label}</Text></div><Badge color={statusMeta[project.status].color}>{project.items.length} 项</Badge></header>
      {stages.map((stage, index) => (
        <section key={stage.id}>
          <div className="print-stage-title"><span>{String(index + 1).padStart(2, '0')}</span><div><Heading size="5">{stage.name}</Heading><Text color="gray" size="1">{stage.description}</Text></div></div>
          <table>
            <thead><tr><th style={{ width: '34%' }}>挑战语</th><th style={{ width: '25%' }}>预期回应</th><th>异常处理</th></tr></thead>
            <tbody>
              {project.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).map((item) => (
                <tr key={item.id}><td>{item.critical && <span className="critical-mark">◆</span>} {item.challenge}</td><td><strong>{item.response || '未填写'}</strong></td><td>{item.abnormalProcedure || '—'}</td></tr>
              ))}
              {!project.items.some((item) => item.stageId === stage.id) && <tr><td colSpan={3}>本阶段暂无检查项</td></tr>}
            </tbody>
          </table>
        </section>
      ))}
    </article>
  );
}

export default App;
