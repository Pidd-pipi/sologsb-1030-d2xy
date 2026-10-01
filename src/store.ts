import { useCallback, useEffect, useRef, useState } from 'react';
import { createInitialState } from './data';
import { mergeWorkspace, recomputeReachability } from './merge';
import type {
  ChecklistItem,
  ChecklistProject,
  FlightStage,
  ItemConflict,
  WorkspaceState
} from './types';
import { validateProject } from './validation';

const STORAGE_KEY = 'sologsb-1030-workspace-v1';
const LEASE_TTL_MS = 12_000;
const HEARTBEAT_MS = 3_000;
const AUTO_SAVE_DEBOUNCE_MS = 1_200;

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();

/** 每个浏览器标签页一个稳定身份（sessionStorage 跨刷新保留）。 */
const tabId = (() => {
  try {
    let id = sessionStorage.getItem('sologsb-tab-id');
    if (!id) {
      id = uid('tab');
      sessionStorage.setItem('sologsb-tab-id', id);
    }
    return id;
  } catch {
    return uid('tab');
  }
})();

const tabName = (() => {
  try {
    const seq = Number.parseInt(localStorage.getItem('sologsb-tab-seq') ?? '0', 10) + 1;
    localStorage.setItem('sologsb-tab-seq', String(seq));
    return `标签页 ${seq}`;
  } catch {
    return '标签页';
  }
})();

const channel = (() => {
  try {
    return new BroadcastChannel('sologsb-1030-sync');
  } catch {
    return null;
  }
})();

function migrate(state: WorkspaceState): WorkspaceState {
  state.projects.forEach((project) => {
    project.lease ??= null;
    project.conflicts ??= [];
    project.orderEpoch ??= 0;
    project.reachability ??= { status: 'ok', orderEpoch: project.orderEpoch, issueIds: [], computedAt: null };
    project.items.forEach((item) => {
      item.version ??= 1;
    });
  });
  return state;
}

function readWorkspace(): WorkspaceState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as WorkspaceState;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.projects) && parsed.projects.length) {
        return migrate(parsed);
      }
    }
  } catch {
    // 本地数据损坏时回退到内置检查单。
  }
  return migrate(createInitialState());
}

function writeWorkspace(state: WorkspaceState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function leaseActive(project: ChecklistProject): boolean {
  return !!project.lease && new Date(project.lease.expiresAt).getTime() > Date.now();
}

function leaseHeldByUs(project: ChecklistProject): boolean {
  return leaseActive(project) && project.lease?.holderId === tabId;
}

function freshLease() {
  return {
    holderId: tabId,
    holderName: tabName,
    acquiredAt: now(),
    expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
    heartbeatAt: now()
  };
}

/** 比较检查项内容（忽略版本号与保存时间），用于判断是否被修改。 */
export type CommitResult = { ok: boolean; reason?: string; newConflicts?: ItemConflict[] };

export function useChecklistStore() {
  const [state, setState] = useState<WorkspaceState>(readWorkspace);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 最近一次确认（获取租约 / 保存成功 / 重新确认）时的完整工作区快照。 */
  const confirmedRef = useRef<WorkspaceState>(clone(state));

  const initialProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0];
  const [leaseHeld, setLeaseHeld] = useState(() => leaseHeldByUs(initialProject));
  const [leaseHolder, setLeaseHolder] = useState<string | null>(() => initialProject.lease?.holderName ?? null);
  const [stale, setStale] = useState(() => !leaseHeldByUs(initialProject));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictTick, setConflictTick] = useState(0);

  const past = useRef<WorkspaceState[]>([]);
  const future = useRef<WorkspaceState[]>([]);
  const [, forceHistoryState] = useState(0);
  const saveTimer = useRef<number | null>(null);
  /** 租约失效后自动保存未能落盘时标记，重新确认后补保存。 */
  const pendingSaveRef = useRef(false);

  const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0];
  const conflicts = selectedProject.conflicts;
  const unresolvedConflicts = conflicts.filter((conflict) => !conflict.resolved);

  const acquireLease = useCallback((): boolean => {
    const fresh = readWorkspace();
    const project = fresh.projects.find((entry) => entry.id === fresh.selectedProjectId);
    if (!project) return false;
    if (leaseActive(project) && project.lease?.holderId !== tabId) return false;
    project.lease = freshLease();
    writeWorkspace(fresh);
    channel?.postMessage({ type: 'lease-acquired', projectId: project.id });
    confirmedRef.current = clone(fresh);
    setState(fresh);
    setLeaseHeld(true);
    setLeaseHolder(tabName);
    setStale(false);
    return true;
  }, []);

  const releaseLease = useCallback(() => {
    const fresh = readWorkspace();
    const project = fresh.projects.find((entry) => entry.id === fresh.selectedProjectId);
    if (project && leaseHeldByUs(project)) {
      project.lease = null;
      writeWorkspace(fresh);
      channel?.postMessage({ type: 'lease-released', projectId: project.id });
    }
  }, []);

  /** 接收其他标签页的租约/内容变化：租约易主则进入只读并提示重新确认。 */
  const handleFresh = useCallback((fresh: WorkspaceState) => {
    const project = fresh.projects.find((entry) => entry.id === fresh.selectedProjectId);
    if (!project) return;
    if (leaseHeldByUs(project)) {
      setLeaseHeld(true);
      setStale(false);
      return;
    }
    setLeaseHeld(false);
    setLeaseHolder(project.lease?.holderName ?? null);
    setStale(true);
    const dirty = JSON.stringify(stateRef.current) !== JSON.stringify(confirmedRef.current);
    if (!dirty) {
      confirmedRef.current = clone(fresh);
      setState(fresh);
    }
  }, []);

  const commitWrite = useCallback((manual: boolean): CommitResult => {
    const fresh = readWorkspace();
    const freshProject = fresh.projects.find((entry) => entry.id === fresh.selectedProjectId);
    if (!freshProject) return { ok: false, reason: 'no-project' };

    if (!leaseHeldByUs(freshProject)) {
      if (!leaseActive(freshProject)) {
        freshProject.lease = freshLease();
      } else {
        setLeaseHeld(false);
        setLeaseHolder(freshProject.lease?.holderName ?? null);
        setStale(true);
        pendingSaveRef.current = true;
        const reason = '租约已被其他标签页接管或已失效，本次保存被阻止。请重新确认后再保存。';
        if (manual) setSaveError(reason);
        return { ok: false, reason: 'lease-expired' };
      }
    }

    const working = stateRef.current;
    const base = confirmedRef.current;
    const { state: next, newConflicts } = mergeWorkspace(fresh, working, base, {
      now,
      uid,
      freshLease: () => ({ ...freshLease(), expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString() })
    });
    writeWorkspace(next);
    const mergedProject = next.projects.find((entry) => entry.id === next.selectedProjectId)!;
    channel?.postMessage({ type: 'state-changed', projectId: mergedProject.id });
    confirmedRef.current = clone(next);
    setState(next);
    pendingSaveRef.current = false;
    setSaveError(null);
    if (newConflicts.length) setConflictTick((tick) => tick + 1);
    return { ok: true, newConflicts };
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      commitWrite(false);
    }, AUTO_SAVE_DEBOUNCE_MS);
  }, [commitWrite]);

  const mutate = useCallback(
    (mutator: (project: ChecklistProject) => void, options: { reorder?: boolean } = {}) => {
      setState((current) => {
        const next = clone(current);
        const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
        if (!project) return current;
        if (project.status !== 'draft') return current;
        past.current = [...past.current.slice(-39), clone(current)];
        future.current = [];
        forceHistoryState((value) => value + 1);
        mutator(project);
        project.updatedAt = now();
        if (options.reorder) {
          project.orderEpoch += 1;
          project.reachability = { status: 'stale', orderEpoch: project.orderEpoch, issueIds: [], computedAt: null };
        }
        scheduleSave();
        return next;
      });
    },
    [scheduleSave]
  );

  const reconfirm = useCallback(() => {
    const fresh = readWorkspace();
    const project = fresh.projects.find((entry) => entry.id === fresh.selectedProjectId);
    if (!project) return;
    if (!leaseActive(project)) {
      // 租约空闲：接管租约，但保留工作副本，立即走版本核对，
      // 与对方改动冲突的项会登记为冲突而不是被覆盖。
      const result = commitWrite(true);
      if (result.ok) {
        setLeaseHeld(true);
        setLeaseHolder(tabName);
        setStale(false);
        pendingSaveRef.current = false;
      } else {
        setStale(true);
      }
    } else if (project.lease?.holderId === tabId) {
      confirmedRef.current = clone(fresh);
      setState(fresh);
      setLeaseHeld(true);
      setStale(false);
    } else {
      // 租约仍在他人手中：同步只读内容，等待对方释放。
      confirmedRef.current = clone(fresh);
      setState(fresh);
      setLeaseHolder(project.lease?.holderName ?? null);
    }
  }, [commitWrite]);

  const recomputeReachabilityNow = useCallback(() => {
    setState((current) => {
      const next = clone(current);
      const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
      if (!project) return current;
      project.reachability = recomputeReachability(project, now);
      scheduleSave();
      return next;
    });
  }, [scheduleSave]);

  const resolveConflict = useCallback(
    (conflictId: string, resolution: 'local' | 'remote') => {
      setState((current) => {
        const next = clone(current);
        const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
        if (!project) return current;
        const conflict = project.conflicts.find((entry) => entry.id === conflictId);
        if (!conflict || conflict.resolved) return current;
        conflict.resolved = true;
        conflict.resolution = resolution;
        if (resolution === 'local') {
          if (conflict.local) {
            const index = project.items.findIndex((item) => item.id === conflict.itemId);
            if (index >= 0) project.items[index] = clone(conflict.local);
            else project.items.push(clone(conflict.local));
          } else {
            project.items = project.items.filter((item) => item.id !== conflict.itemId);
          }
        }
        // remote 版本即当前落盘内容，选择对方时无需改动。
        scheduleSave();
        return next;
      });
    },
    [scheduleSave]
  );

  // 心跳：租约有效期内持续续约，失效则进入只读。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const fresh = readWorkspace();
      const project = fresh.projects.find((entry) => entry.id === fresh.selectedProjectId);
      if (!project) return;
      if (leaseHeldByUs(project)) {
        project.lease = {
          ...project.lease!,
          expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
          heartbeatAt: now()
        };
        writeWorkspace(fresh);
        channel?.postMessage({ type: 'lease-renewed', projectId: project.id });
      } else {
        handleFresh(fresh);
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [handleFresh]);

  // 监听其他标签页的写入与租约消息。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try {
          handleFresh(JSON.parse(event.newValue) as WorkspaceState);
        } catch {
          // 忽略损坏的跨页数据。
        }
      }
    };
    const onChannel = (message: unknown) => {
      const msg = message as { type?: string };
      if (msg.type && ['lease-acquired', 'lease-released', 'lease-renewed', 'state-changed'].includes(msg.type)) {
        handleFresh(readWorkspace());
      }
    };
    window.addEventListener('storage', onStorage);
    channel?.addEventListener('message', onChannel);
    return () => {
      window.removeEventListener('storage', onStorage);
      channel?.removeEventListener('message', onChannel);
    };
  }, [handleFresh]);

  // 页面隐藏/关闭时释放租约，回到前台时重新确认。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        releaseLease();
      } else {
        handleFresh(readWorkspace());
      }
    };
    const onPageHide = () => releaseLease();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [handleFresh, releaseLease]);

  // 挂载时尝试获取租约（StrictMode 双调用时第二次会直接续约）。
  useEffect(() => {
    acquireLease();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProject = useCallback(
    (id: string) => {
      const fresh = readWorkspace();
      const current = fresh.projects.find((entry) => entry.id === fresh.selectedProjectId);
      if (current && leaseHeldByUs(current)) current.lease = null;
      fresh.selectedProjectId = id;
      writeWorkspace(fresh);
      channel?.postMessage({ type: 'lease-released' });
      confirmedRef.current = clone(fresh);
      setState(fresh);
      window.setTimeout(() => acquireLease(), 0);
    },
    [acquireLease]
  );

  const addProject = useCallback(() => {
    const id = uid('project');
    setState((current) => {
      const next = clone(current);
      next.projects.push({
        id,
        name: 'Untitled checklist',
        aircraft: '新机型',
        revision: 1,
        status: 'draft',
        updatedAt: now(),
        reviewNote: '',
        stages: [{ id: uid('stage'), name: '飞行前检查', order: 0, description: '说明本阶段目标。' }],
        items: [],
        revisions: [],
        lease: null,
        conflicts: [],
        orderEpoch: 0,
        reachability: { status: 'ok', orderEpoch: 0, issueIds: [], computedAt: null }
      });
      next.selectedProjectId = id;
      writeWorkspace(next);
      confirmedRef.current = clone(next);
      return next;
    });
    window.setTimeout(() => acquireLease(), 0);
  }, [acquireLease]);

  const updateProject = useCallback(
    (patch: Partial<ChecklistProject>) => {
      mutate((project) => {
        Object.assign(project, patch);
      });
    },
    [mutate]
  );

  const addStage = useCallback(() => {
    mutate((project) => {
      project.stages.push({ id: uid('stage'), name: '新飞行阶段', order: project.stages.length, description: '描述阶段目标和适用条件。' });
    });
  }, [mutate]);

  const updateStage = useCallback(
    (stageId: string, patch: Partial<FlightStage>) => {
      mutate((project) => {
        const stage = project.stages.find((entry) => entry.id === stageId);
        if (stage) Object.assign(stage, patch);
      });
    },
    [mutate]
  );

  const moveStage = useCallback(
    (stageId: string, direction: -1 | 1) => {
      mutate(
        (project) => {
          project.stages.sort((a, b) => a.order - b.order);
          const index = project.stages.findIndex((entry) => entry.id === stageId);
          const target = index + direction;
          if (index < 0 || target < 0 || target >= project.stages.length) return;
          [project.stages[index], project.stages[target]] = [project.stages[target], project.stages[index]];
          project.stages.forEach((entry, order) => {
            entry.order = order;
          });
        },
        { reorder: true }
      );
    },
    [mutate]
  );

  const deleteStage = useCallback(
    (stageId: string) => {
      mutate((project) => {
        if (project.items.some((item) => item.stageId === stageId)) return;
        project.stages = project.stages.filter((stage) => stage.id !== stageId).sort((a, b) => a.order - b.order);
        project.stages.forEach((stage, order) => {
          stage.order = order;
        });
      });
    },
    [mutate]
  );

  const addItem = useCallback(
    (stageId: string, challenge = '', response = '') => {
      const id = uid('item');
      mutate((project) => {
        const stage = project.stages.find((entry) => entry.id === stageId);
        if (!stage) return;
        const order = project.items.filter((item) => item.stageId === stageId).length;
        project.items.push({
          id,
          stageId,
          order,
          challenge,
          response,
          critical: false,
          preconditionIds: [],
          abnormalProcedure: '',
          version: 1,
          updatedAt: now()
        });
      });
      return id;
    },
    [mutate]
  );

  const updateItem = useCallback(
    (itemId: string, patch: Partial<ChecklistItem>) => {
      mutate((project) => {
        const item = project.items.find((entry) => entry.id === itemId);
        if (item) {
          Object.assign(item, patch, { version: item.version + 1, updatedAt: now() });
        }
      });
    },
    [mutate]
  );

  const deleteItem = useCallback(
    (itemId: string) => {
      mutate((project) => {
        project.items = project.items.filter((item) => item.id !== itemId);
        project.items.forEach((item) => {
          item.preconditionIds = item.preconditionIds.filter((id) => id !== itemId);
        });
        project.stages.forEach((stage) => {
          project.items
            .filter((item) => item.stageId === stage.id)
            .sort((a, b) => a.order - b.order)
            .forEach((item, order) => {
              item.order = order;
            });
        });
      });
    },
    [mutate]
  );

  const reorderItem = useCallback(
    (sourceId: string, targetId: string, before = true) => {
      mutate(
        (project) => {
          const source = project.items.find((item) => item.id === sourceId);
          const target = project.items.find((item) => item.id === targetId);
          if (!source || !target || source.id === target.id) return;
          source.stageId = target.stageId;
          const siblings = project.items
            .filter((item) => item.stageId === target.stageId && item.id !== source.id)
            .sort((a, b) => a.order - b.order);
          const targetIndex = siblings.findIndex((item) => item.id === target.id);
          siblings.splice(Math.max(0, targetIndex + (before ? 0 : 1)), 0, source);
          siblings.forEach((item, order) => {
            item.order = order;
          });
        },
        { reorder: true }
      );
    },
    [mutate]
  );

  const nudgeItem = useCallback(
    (itemId: string, direction: -1 | 1) => {
      mutate(
        (project) => {
          const item = project.items.find((entry) => entry.id === itemId);
          if (!item) return;
          const siblings = project.items
            .filter((entry) => entry.stageId === item.stageId)
            .sort((a, b) => a.order - b.order);
          const index = siblings.findIndex((entry) => entry.id === itemId);
          const target = index + direction;
          if (target < 0 || target >= siblings.length) return;
          [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
          siblings.forEach((entry, order) => {
            entry.order = order;
          });
        },
        { reorder: true }
      );
    },
    [mutate]
  );

  const workflowAction = useCallback(
    (mutator: (project: ChecklistProject) => void) => {
      setState((current) => {
        const next = clone(current);
        const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
        if (!project) return current;
        past.current = [...past.current.slice(-39), clone(current)];
        future.current = [];
        forceHistoryState((value) => value + 1);
        mutator(project);
        project.updatedAt = now();
        scheduleSave();
        return next;
      });
    },
    [scheduleSave]
  );

  const guardWorkflow = useCallback(
    (action: 'review' | 'freeze' | 'revision'): { ok: boolean; reason?: string } => {
      const project = stateRef.current.projects.find((entry) => entry.id === stateRef.current.selectedProjectId);
      if (!project) return { ok: false, reason: '未找到检查单项目。' };
      if (!leaseHeldByUs(project)) return { ok: false, reason: '需要先获取写入租约才能继续。请点击“重新确认”。' };
      if (project.conflicts.some((conflict) => !conflict.resolved)) {
        return { ok: false, reason: '存在未处理的并发冲突，人工处理前不能提交复核或冻结。' };
      }
      if (project.reachability.status !== 'ok') {
        return { ok: false, reason: '检查项顺序已变化，前置条件可达性重新核算并处理前不能提交复核或冻结。' };
      }
      if (action !== 'revision') {
        const errors = validateProject(project).filter((issue) => issue.level === 'error').length;
        if (errors) return { ok: false, reason: '存在阻断性校验问题，处理后才能提交复核或冻结。' };
      }
      return { ok: true };
    },
    []
  );

  const submitForReview = useCallback((): { ok: boolean; reason?: string } => {
    const guard = guardWorkflow('review');
    if (!guard.ok) return guard;
    workflowAction((project) => {
      project.status = 'review';
      project.reviewNote = '';
    });
    return { ok: true };
  }, [guardWorkflow, workflowAction]);

  const freezeRevision = useCallback(
    (note: string): { ok: boolean; reason?: string } => {
      const guard = guardWorkflow('freeze');
      if (!guard.ok) return guard;
      workflowAction((project) => {
        const version = project.revision;
        const snapshot = {
          id: uid('revision'),
          revision: version,
          status: 'frozen' as const,
          createdAt: now(),
          note: note.trim() || '复核通过并冻结',
          stages: clone(project.stages),
          items: clone(project.items)
        };
        project.revisions.unshift(snapshot);
        project.status = 'frozen';
        project.reviewNote = note.trim();
      });
      return { ok: true };
    },
    [guardWorkflow, workflowAction]
  );

  const createRevision = useCallback((): { ok: boolean; reason?: string } => {
    const guard = guardWorkflow('revision');
    if (!guard.ok) return guard;
    workflowAction((project) => {
      project.revision += 1;
      project.status = 'draft';
      project.reviewNote = '';
    });
    return { ok: true };
  }, [guardWorkflow, workflowAction]);

  const undo = useCallback(() => {
    setState((current) => {
      const previous = past.current.pop();
      if (!previous) return current;
      future.current = [clone(current), ...future.current].slice(0, 40);
      forceHistoryState((value) => value + 1);
      return previous;
    });
    window.setTimeout(() => commitWrite(false), 0);
  }, [commitWrite]);

  const redo = useCallback(() => {
    setState((current) => {
      const next = future.current.shift();
      if (!next) return current;
      past.current = [...past.current.slice(-39), clone(current)];
      forceHistoryState((value) => value + 1);
      return next;
    });
    window.setTimeout(() => commitWrite(false), 0);
  }, [commitWrite]);

  const saveNow = useCallback((): CommitResult => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    return commitWrite(true);
  }, [commitWrite]);

  return {
    state,
    selectedProject,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    leaseHeld,
    leaseHolder,
    stale,
    saveError,
    unresolvedConflicts,
    conflictTick,
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
    recomputeReachabilityNow,
    resolveConflict,
    reconfirm,
    undo,
    redo,
    saveNow
  };
}
