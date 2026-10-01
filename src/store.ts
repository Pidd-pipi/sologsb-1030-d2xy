import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { createInitialState } from './data';
import { hasPendingEdits, mergeWorkspace } from './merge';
import { currentLeaseFor, readLeases } from './collaboration';
import type {
  ChecklistItem,
  ChecklistProject,
  ChecklistRevision,
  FlightStage,
  SaveResult,
  WorkspaceState
} from './types';
import { validateProject } from './validation';

const STORAGE_KEY = 'sologsb-1030-workspace-v1';
const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();

/** 补齐旧版本本地数据中缺失的版本号与并发控制字段。 */
function normalizeState(parsed: WorkspaceState): WorkspaceState {
  parsed.projects.forEach((project) => {
    if (typeof project.contentVersion !== 'number') project.contentVersion = 1;
    if (typeof project.orderCheckPending !== 'boolean') project.orderCheckPending = false;
    if (!Array.isArray(project.conflicts)) project.conflicts = [];
    project.stages.forEach((stage) => {
      if (typeof stage.version !== 'number') stage.version = 1;
    });
    project.items.forEach((item) => {
      if (typeof item.version !== 'number') item.version = 1;
    });
  });
  return parsed;
}

function loadState(): WorkspaceState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as WorkspaceState;
      if (parsed.schemaVersion === 1 && parsed.projects?.length) return normalizeState(parsed);
    }
  } catch {
    // Corrupted local draft falls back to the bundled operational checklist.
  }
  return createInitialState();
}

function readStoredState(): WorkspaceState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (parsed.schemaVersion === 1 && parsed.projects?.length) return normalizeState(parsed);
  } catch {
    // 存储被破坏时当作没有远端版本，由持有者的本地状态接管。
  }
  return null;
}

/** 忽略当前选中项目这一纯本地 UI 状态，只比较实际内容是否分叉。 */
const comparable = (value: WorkspaceState) => JSON.stringify({ ...value, selectedProjectId: '' });

export interface StoreOptions {
  sessionIdRef: MutableRefObject<string>;
  /** 租约身份：值为当前持有者 id 时本页可写，null 时只读。 */
  leaseHolderIdRef: MutableRefObject<string | null>;
}

/** 普通自动保存静默落盘；这些状态必须明确告知编辑者。 */
const NOTABLE_STATUSES: ReadonlySet<SaveResult['status']> = new Set(['merged', 'conflicts', 'readonly', 'lease-lost', 'blocked']);

export function useChecklistStore(options: StoreOptions) {
  const [state, setState] = useState<WorkspaceState>(loadState);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 本页最近一次与存储一致时的快照，作为三方合并的 base。 */
  const baseRef = useRef<WorkspaceState>(clone(state));
  const past = useRef<WorkspaceState[]>([]);
  const future = useRef<WorkspaceState[]>([]);
  const [, forceHistoryState] = useState(0);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [remoteUpdateAt, setRemoteUpdateAt] = useState<string | null>(null);

  const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0];

  /** 失效旧页面：带着与已确认快照不一致、尚未合并落盘的修改。 */
  const pendingEdits = useCallback(() => {
    const baseProject = baseRef.current.projects.find((project) => project.id === stateRef.current.selectedProjectId);
    const currentProject = stateRef.current.projects.find((project) => project.id === stateRef.current.selectedProjectId);
    return Boolean(currentProject && hasPendingEdits(baseProject, currentProject));
  }, []);

  const isHolder = useCallback(() => {
    const lease = currentLeaseFor(stateRef.current.selectedProjectId);
    return Boolean(lease && lease.holderId === options.sessionIdRef.current);
  }, [options.sessionIdRef]);

  const remoteHolderName = useCallback((projectId: string) => readLeases()[projectId]?.holderName ?? '其他页面', []);

  /**
   * 把本地状态与存储中的他页最新版本做三方合并并写回。
   * 只有租约持有者可以写入；这也是"保存前核对项目版本"的唯一落盘入口。
   */
  const flush = useCallback((): SaveResult => {
    const local = clone(stateRef.current);
    const holderId = options.leaseHolderIdRef.current;
    if (!holderId || holderId !== options.sessionIdRef.current) {
      return { status: 'readonly', detail: '本页面没有编辑租约，只能查看。' };
    }
    const lease = currentLeaseFor(local.selectedProjectId);
    if (!lease || lease.holderId !== holderId) {
      return { status: 'lease-lost', detail: '编辑租约已失效，页面已转为只读，请重新确认后再保存。' };
    }

    const stored = readStoredState();
    const base = baseRef.current;
    let toWrite = local;
    let status: SaveResult['status'] = 'saved';
    let detail: string | undefined;

    if (stored) {
      const localDirty = comparable(base) !== comparable(local);
      const remoteAhead = comparable(base) !== comparable(stored);
      if (!localDirty && !remoteAhead) return { status: 'uptodate', detail: '没有待保存的修改。' };
      if (remoteAhead) {
        const outcome = mergeWorkspace(base, local, stored, lease.holderName, remoteHolderName(local.selectedProjectId));
        toWrite = outcome.state;
        if (localDirty) {
          status = outcome.hasConflicts ? 'conflicts' : 'merged';
          detail = outcome.hasConflicts
            ? '检测到另一页面也修改了同一检查项，已挂起为冲突，需人工处理后才能提交复核。'
            : '已与另一页面的修改合并保存。';
        } else {
          status = 'synced';
          detail = '已同步另一页面的最新版本。';
        }
      }
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(toWrite));
    baseRef.current = clone(toWrite);
    stateRef.current = toWrite;
    if (JSON.stringify(toWrite) !== JSON.stringify(local)) setState(toWrite);
    return { status, detail };
  }, [options.leaseHolderIdRef, options.sessionIdRef, remoteHolderName]);

  /** 同步提交下一状态：先更新 ref 再落盘，保证保存时核对到的就是本次编辑。 */
  const commitState = useCallback((next: WorkspaceState): SaveResult => {
    stateRef.current = next;
    setState(next);
    return flush();
  }, [flush]);

  const notifySave = useCallback((result: SaveResult) => {
    setSaveResult(result);
    window.setTimeout(() => setSaveResult((current) => (current === result ? null : current)), 4000);
  }, []);

  const notifyIfNotable = useCallback((result: SaveResult) => {
    if (NOTABLE_STATUSES.has(result.status)) notifySave(result);
  }, [notifySave]);

  /** 编辑类操作：必须持有租约且检查单处于编辑中。 */
  const applyMutation = useCallback((mutator: (project: ChecklistProject) => void) => {
    if (!isHolder()) return;
    const current = stateRef.current;
    const next = clone(current);
    const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
    if (!project || project.status !== 'draft') return;
    past.current = [...past.current.slice(-39), clone(current)];
    future.current = [];
    forceHistoryState((value) => value + 1);
    mutator(project);
    project.updatedAt = now();
    notifyIfNotable(commitState(next));
  }, [commitState, isHolder, notifyIfNotable]);

  /** 工作流类操作（提交复核/冻结/修订/重算）：同样需要租约，mutator 返回 blocked 则中止。 */
  const applyTransition = useCallback((mutator: (project: ChecklistProject) => SaveResult | void): SaveResult => {
    if (!isHolder()) {
      const result: SaveResult = { status: 'readonly', detail: '没有编辑租约，无法变更发布状态。' };
      notifySave(result);
      return result;
    }
    const current = stateRef.current;
    const next = clone(current);
    const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
    if (!project) return { status: 'blocked', detail: '未选择检查单。' };
    const verdict = mutator(project);
    if (verdict && verdict.status === 'blocked') {
      notifySave(verdict);
      return verdict;
    }
    past.current = [...past.current.slice(-39), clone(current)];
    future.current = [];
    forceHistoryState((value) => value + 1);
    project.updatedAt = now();
    const result = commitState(next);
    notifySave(result);
    return result;
  }, [commitState, isHolder, notifySave]);

  const selectProject = useCallback((id: string) => {
    setState((current) => ({ ...current, selectedProjectId: id }));
  }, []);

  const addProject = useCallback(() => {
    // 新建项目不依赖当前项目的租约；它会成为新的选中项，App 会随项目切换申请租约。
    const id = uid('project');
    const current = stateRef.current;
    const next = clone(current);
    past.current = [...past.current.slice(-39), clone(current)];
    future.current = [];
    next.projects.push({
      id,
      name: 'Untitled checklist',
      aircraft: '新机型',
      revision: 1,
      status: 'draft',
      updatedAt: now(),
      reviewNote: '',
      stages: [{ id: uid('stage'), name: '飞行前检查', order: 0, description: '说明本阶段目标。', version: 1 }],
      items: [],
      revisions: [],
      contentVersion: 1,
      orderCheckPending: false,
      conflicts: []
    });
    next.selectedProjectId = id;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    baseRef.current = clone(next);
    stateRef.current = next;
    setState(next);
    forceHistoryState((value) => value + 1);
  }, []);

  const updateProject = useCallback((patch: Partial<ChecklistProject>) => {
    applyMutation((project) => {
      Object.assign(project, patch);
    });
  }, [applyMutation]);

  const addStage = useCallback(() => {
    applyMutation((project) => {
      project.stages.push({ id: uid('stage'), name: '新飞行阶段', order: project.stages.length, description: '描述阶段目标和适用条件。', version: 1 });
    });
  }, [applyMutation]);

  const updateStage = useCallback((stageId: string, patch: Partial<FlightStage>) => {
    applyMutation((project) => {
      const stage = project.stages.find((entry) => entry.id === stageId);
      if (stage) Object.assign(stage, patch, { version: stage.version + 1 });
    });
  }, [applyMutation]);

  const moveStage = useCallback((stageId: string, direction: -1 | 1) => {
    applyMutation((project) => {
      project.stages.sort((a, b) => a.order - b.order);
      const index = project.stages.findIndex((entry) => entry.id === stageId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= project.stages.length) return;
      [project.stages[index], project.stages[target]] = [project.stages[target], project.stages[index]];
      project.stages.forEach((entry, order) => {
        entry.order = order;
        entry.version += 1;
      });
      // 阶段顺序变化会影响跨阶段前置条件的可达性，必须重新核对。
      project.orderCheckPending = true;
    });
  }, [applyMutation]);

  const deleteStage = useCallback((stageId: string) => {
    applyMutation((project) => {
      if (project.items.some((item) => item.stageId === stageId)) return;
      project.stages = project.stages.filter((stage) => stage.id !== stageId).sort((a, b) => a.order - b.order);
      project.stages.forEach((stage, order) => { stage.order = order; });
    });
  }, [applyMutation]);

  const addItem = useCallback((stageId: string, challenge = '', response = '') => {
    const id = uid('item');
    applyMutation((project) => {
      const stage = project.stages.find((entry) => entry.id === stageId);
      if (!stage) return;
      const order = project.items.filter((item) => item.stageId === stageId).length;
      project.items.push({ id, stageId, order, challenge, response, critical: false, preconditionIds: [], abnormalProcedure: '', updatedAt: now(), version: 1 });
    });
    return id;
  }, [applyMutation]);

  const updateItem = useCallback((itemId: string, patch: Partial<ChecklistItem>) => {
    applyMutation((project) => {
      const item = project.items.find((entry) => entry.id === itemId);
      if (item) Object.assign(item, patch, { updatedAt: now(), version: item.version + 1 });
    });
  }, [applyMutation]);

  const deleteItem = useCallback((itemId: string) => {
    applyMutation((project) => {
      project.items = project.items.filter((item) => item.id !== itemId);
      project.items.forEach((item) => { item.preconditionIds = item.preconditionIds.filter((id) => id !== itemId); });
      project.stages.forEach((stage) => {
        project.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).forEach((item, order) => { item.order = order; });
      });
      // 删除后后续检查项前移，前置条件可达性需要重新核对。
      project.orderCheckPending = true;
    });
  }, [applyMutation]);

  const reorderItem = useCallback((sourceId: string, targetId: string, before = true) => {
    applyMutation((project) => {
      const source = project.items.find((item) => item.id === sourceId);
      const target = project.items.find((item) => item.id === targetId);
      if (!source || !target || source.id === target.id) return;
      const oldOrders = new Map(project.items.map((item) => [item.id, `${item.stageId}#${item.order}`]));
      source.stageId = target.stageId;
      const siblings = project.items.filter((item) => item.stageId === target.stageId && item.id !== source.id).sort((a, b) => a.order - b.order);
      const targetIndex = siblings.findIndex((item) => item.id === target.id);
      siblings.splice(Math.max(0, targetIndex + (before ? 0 : 1)), 0, source);
      siblings.forEach((item, order) => {
        if (oldOrders.get(item.id) !== `${item.stageId}#${order}`) item.version += 1;
        item.order = order;
      });
      // 检查项顺序（含跨阶段移动）一变，前置条件可达性必须重新算出。
      project.orderCheckPending = true;
    });
  }, [applyMutation]);

  const nudgeItem = useCallback((itemId: string, direction: -1 | 1) => {
    applyMutation((project) => {
      const item = project.items.find((entry) => entry.id === itemId);
      if (!item) return;
      const siblings = project.items.filter((entry) => entry.stageId === item.stageId).sort((a, b) => a.order - b.order);
      const index = siblings.findIndex((entry) => entry.id === itemId);
      const target = index + direction;
      if (target < 0 || target >= siblings.length) return;
      [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
      siblings.forEach((entry, order) => { entry.order = order; entry.version += 1; });
      project.orderCheckPending = true;
    });
  }, [applyMutation]);

  const guardPublishable = useCallback((project: ChecklistProject, freeze = false): SaveResult | null => {
    if (project.conflicts.length > 0) {
      return { status: 'blocked', detail: `还有 ${project.conflicts.length} 个两页同改的检查项未人工处理，不能${freeze ? '冻结' : '提交复核'}。` };
    }
    if (project.orderCheckPending) {
      return { status: 'blocked', detail: '检查项顺序已变化，前置条件可达性尚未重新核对，不能' + (freeze ? '冻结' : '提交复核') + '。' };
    }
    const errors = validateProject(project).filter((issue) => issue.level === 'error');
    if (errors.length > 0) {
      return { status: 'blocked', detail: `仍有 ${errors.length} 个阻断校验问题，不能${freeze ? '冻结' : '提交复核'}。` };
    }
    return null;
  }, []);

  const submitForReview = useCallback((): SaveResult => applyTransition((project) => {
    const blocked = guardPublishable(project);
    if (blocked) return blocked;
    project.status = 'review';
    project.reviewNote = '';
  }), [applyTransition, guardPublishable]);

  const freezeRevision = useCallback((note: string): SaveResult => applyTransition((project) => {
    const blocked = guardPublishable(project, true);
    if (blocked) return blocked;
    const snapshot: ChecklistRevision = {
      id: uid('revision'),
      revision: project.revision,
      status: 'frozen',
      createdAt: now(),
      note: note.trim() || '复核通过并冻结',
      stages: clone(project.stages),
      items: clone(project.items)
    };
    project.revisions.unshift(snapshot);
    project.status = 'frozen';
    project.reviewNote = note.trim();
  }), [applyTransition, guardPublishable]);

  const createRevision = useCallback((): SaveResult => applyTransition((project) => {
    project.revision += 1;
    project.status = 'draft';
    project.reviewNote = '';
    project.orderCheckPending = false;
  }), [applyTransition]);

  /** 重新核对前置条件可达性：通过后清除顺序待确认标记。 */
  const recheckReachability = useCallback((): SaveResult => applyTransition((project) => {
    const unreachable = validateProject(project).filter((issue) => issue.type === 'unreachable-precondition' && issue.level === 'error');
    if (unreachable.length > 0) {
      return { status: 'blocked', detail: `重新核对发现 ${unreachable.length} 个不可达前置条件，请先调整顺序或移除引用。` };
    }
    project.orderCheckPending = false;
  }), [applyTransition]);

  /** 人工处理同项冲突：采用本页/采用他页/保留为两项/删除。 */
  const resolveConflict = useCallback((itemId: string, decision: 'local' | 'remote' | 'both' | 'discard') => {
    if (!isHolder()) {
      notifySave({ status: 'readonly', detail: '只有持有租约的页面可以处理冲突。' });
      return;
    }
    const current = stateRef.current;
    const next = clone(current);
    const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
    if (!project) return;
    const conflict = project.conflicts.find((entry) => entry.itemId === itemId);
    if (!conflict) return;

    past.current = [...past.current.slice(-39), clone(current)];
    future.current = [];
    forceHistoryState((value) => value + 1);

    const localItem = conflict.localSnapshot ? { ...clone(conflict.localSnapshot), version: conflict.localSnapshot.version + 1, updatedAt: now() } : null;
    const remoteItem = conflict.remoteSnapshot ? { ...clone(conflict.remoteSnapshot), version: conflict.remoteSnapshot.version + 1, updatedAt: now() } : null;

    project.items = project.items.filter((item) => item.id !== itemId);
    if (decision === 'local' && localItem) project.items.push(localItem);
    if (decision === 'remote' && remoteItem) project.items.push(remoteItem);
    if (decision === 'both') {
      if (localItem) project.items.push(localItem);
      if (remoteItem) {
        remoteItem.id = uid('item');
        remoteItem.challenge = `${remoteItem.challenge || '未命名'}（他页保留）`;
        project.items.push(remoteItem);
      }
    }
    // 清理指向已不存在检查项的前置条件引用，避免合并/解决后留下悬空引用。
    const validIds = new Set(project.items.map((item) => item.id));
    project.items.forEach((item) => {
      item.preconditionIds = item.preconditionIds.filter((preId) => validIds.has(preId));
    });
    project.stages.forEach((stage) => {
      project.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).forEach((item, order) => { item.order = order; });
    });
    project.conflicts = project.conflicts.filter((entry) => entry.itemId !== itemId);
    // 冲突解决可能改变位置，仍要求重新核对一次可达性。
    project.orderCheckPending = true;
    project.updatedAt = now();
    notifyIfNotable(commitState(next));
  }, [commitState, isHolder, notifyIfNotable, notifySave]);

  const undo = useCallback(() => {
    if (!isHolder()) return;
    const previous = past.current.pop();
    if (!previous) return;
    future.current = [clone(stateRef.current), ...future.current].slice(0, 40);
    forceHistoryState((value) => value + 1);
    // 仅回退当前选中项目，其他项目采用存储中的最新版本，避免回退覆盖他页内容。
    const stored = readStoredState();
    const next = clone(previous);
    next.projects = next.projects.map((project) =>
      project.id === stateRef.current.selectedProjectId
        ? project
        : stored?.projects.find((entry) => entry.id === project.id) ?? project
    );
    notifyIfNotable(commitState(next));
  }, [commitState, isHolder, notifyIfNotable]);

  const redo = useCallback(() => {
    if (!isHolder()) return;
    const nextState = future.current.shift();
    if (!nextState) return;
    past.current = [...past.current.slice(-39), clone(stateRef.current)];
    forceHistoryState((value) => value + 1);
    notifyIfNotable(commitState(nextState));
  }, [commitState, isHolder, notifyIfNotable]);

  /** 手动保存：持有者核对项目版本后合并落盘；查看者同步他页最新内容。 */
  const saveNow = useCallback((): SaveResult => {
    if (isHolder()) {
      const result = flush();
      notifySave(result);
      return result;
    }
    // 失效旧页面带着未落盘修改：直接刷新会静默丢掉这些修改，必须先重新获得租约再核对合并。
    if (pendingEdits()) {
      const result: SaveResult = { status: 'lease-lost', detail: '本页有租约失效后尚未保存的修改，不能用刷新覆盖；请先在租约栏重新获得租约并重新确认。' };
      notifySave(result);
      return result;
    }
    // 干净的只读页面：点保存等价于重新确认并同步最新版本。
    const stored = readStoredState();
    if (stored) {
      baseRef.current = clone(stored);
      stateRef.current = stored;
      setState(stored);
      setRemoteUpdateAt(new Date().toISOString());
    }
    const result: SaveResult = { status: 'synced', detail: '本页为只读视图，已刷新为其他页面保存的最新版本。' };
    notifySave(result);
    return result;
  }, [flush, isHolder, notifySave, pendingEdits]);

  /** 租约重新到手时，把失租期间本页带着的旧快照修改与存储最新版本核对合并（重新确认）。 */
  const reconcileOnLease = useCallback((): SaveResult => {
    const stored = readStoredState();
    if (!stored) {
      const flushed = flush();
      notifySave(flushed);
      return flushed;
    }
    const lease = currentLeaseFor(stored.selectedProjectId);
    const holderName = lease?.holderName ?? '本页面';
    const outcome = mergeWorkspace(baseRef.current, clone(stateRef.current), stored, holderName, remoteHolderName(stored.selectedProjectId));
    baseRef.current = clone(outcome.state);
    stateRef.current = outcome.state;
    setState(outcome.state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(outcome.state));
    const result: SaveResult = outcome.hasConflicts
      ? { status: 'conflicts', detail: '重新确认完成：发现两个页面修改过同一检查项，已挂起等待人工处理，在此之前不能提交复核。' }
      : outcome.merged
        ? { status: 'merged', detail: '重新确认完成：本页修改已与最新版本合并。' }
        : { status: 'synced', detail: '重新确认完成：本页已是最新版本。' };
    notifySave(result);
    return result;
  }, [flush, notifySave, remoteHolderName]);

  // 监听其他标签页写入：查看者自动跟进最新版本；持有者留待下次保存时三方合并。
  useEffect(() => {
    const onRemoteChange = () => {
      const holderId = options.leaseHolderIdRef.current;
      if (holderId && holderId === options.sessionIdRef.current) return;
      const stored = readStoredState();
      if (!stored) return;
      const baseProject = baseRef.current.projects.find((project) => project.id === stateRef.current.selectedProjectId);
      const currentProject = stateRef.current.projects.find((project) => project.id === stateRef.current.selectedProjectId);
      const dirty = Boolean(currentProject && hasPendingEdits(baseProject, currentProject));
      if (dirty) return;
      // 失效旧页面带着未落盘修改：保持本地内容只读，等重新获得租约后再核对合并。
      baseRef.current = clone(stored);
      stateRef.current = stored;
      setState(stored);
      setRemoteUpdateAt(new Date().toISOString());
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) onRemoteChange();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onRemoteChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onRemoteChange);
    };
  }, [options.leaseHolderIdRef, options.sessionIdRef]);

  return {
    state,
    selectedProject,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    saveResult,
    remoteUpdateAt,
    pendingEdits,
    isHolder,
    selectProject,
    addProject,
    updateProject,
    addStage,
    updateStage,
    moveStage,
    deleteStage,
    addItem,
    updateItem,
    deleteItem,
    reorderItem,
    nudgeItem,
    submitForReview,
    freezeRevision,
    createRevision,
    recheckReachability,
    resolveConflict,
    reconcileOnLease,
    undo,
    redo,
    saveNow
  };
}

export type ChecklistStore = ReturnType<typeof useChecklistStore>;
