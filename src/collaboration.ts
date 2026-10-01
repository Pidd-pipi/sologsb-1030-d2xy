import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditLease } from './types';

/**
 * 跨标签页编辑租约。
 *
 * 数据全部存放在 localStorage，同一检查单（projectId）同一时刻最多只有一个页面持有租约：
 * - 持有者每 HEARTBEAT_MS 续租一次，租约在 TTL_MS 后自动失效；
 * - 非持有者只能查看，其他页面释放或租约到期后可申请接管；
 * - 页面关闭/隐藏时主动释放租约，方便另一页立即接管。
 */
export const LEASE_STORAGE_KEY = 'sologsb-1030-lease-v1';
export const LEASE_TTL_MS = 15_000;
export const LEASE_HEARTBEAT_MS = 5_000;
export const TICK_MS = 1_000;

export type LeaseRole = 'holder' | 'other' | 'stale' | 'none';

export const newSessionId = () => `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function readLeases(): Record<string, EditLease> {
  try {
    const raw = localStorage.getItem(LEASE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, EditLease>) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLeases(leases: Record<string, EditLease>) {
  localStorage.setItem(LEASE_STORAGE_KEY, JSON.stringify(leases));
}

/** 仅清理本项目的过期租约；其他项目保持不动。 */
function currentLeaseFor(projectId: string, nowMs = Date.now()): EditLease | null {
  const lease = readLeases()[projectId];
  if (!lease) return null;
  if (new Date(lease.expiresAt).getTime() <= nowMs) return null;
  return lease;
}

/** 尝试原子获取租约：不存在、已过期或属于自己时成功。 */
export function acquireLease(projectId: string, holderId: string, holderName: string): EditLease | null {
  const leases = readLeases();
  const nowMs = Date.now();
  const existing = leases[projectId];
  if (existing && existing.holderId !== holderId && new Date(existing.expiresAt).getTime() > nowMs) {
    return null;
  }
  const timestamp = new Date(nowMs).toISOString();
  const lease: EditLease = {
    projectId,
    holderId,
    holderName: holderName || holderId,
    acquiredAt: existing?.holderId === holderId ? existing.acquiredAt : timestamp,
    renewedAt: timestamp,
    expiresAt: new Date(nowMs + LEASE_TTL_MS).toISOString()
  };
  leases[projectId] = lease;
  writeLeases(leases);
  return lease;
}

/** 续租：仅持有者本人可续。 */
export function renewLease(lease: EditLease): EditLease | null {
  const leases = readLeases();
  const existing = leases[lease.projectId];
  if (!existing || existing.holderId !== lease.holderId) return null;
  const nowMs = Date.now();
  const renewed: EditLease = {
    ...existing,
    holderName: lease.holderName || existing.holderName,
    renewedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + LEASE_TTL_MS).toISOString()
  };
  leases[lease.projectId] = renewed;
  writeLeases(leases);
  return renewed;
}

export function releaseLease(projectId: string, holderId: string) {
  const leases = readLeases();
  if (leases[projectId]?.holderId === holderId) {
    delete leases[projectId];
    writeLeases(leases);
  }
}

export { currentLeaseFor, readLeases };

export interface LeaseState {
  lease: EditLease | null;
  role: LeaseRole;
  /** 剩余秒数，用于提示租约状态；过期后归 0。 */
  ttlSeconds: number;
  request: () => EditLease | null;
  release: () => void;
  setHolderName: (name: string) => void;
}

/**
 * 管理当前标签页在某个项目上的租约。
 *
 * @param projectId 当前打开的检查单
 * @param hadWritableLease 本页是否存在未落盘的本地修改（失租时这些修改决定“失效旧页面”的只读语义）
 */
export function useEditLease(projectId: string, hadWritableLease: boolean): LeaseState {
  const sessionIdRef = useRef<string>('');
  if (!sessionIdRef.current) sessionIdRef.current = newSessionId();
  const sessionId = sessionIdRef.current;

  const [editorName, setEditorName] = useState(() => `页面 ${sessionId.slice(-4).toUpperCase()}`);
  const [lease, setLease] = useState<EditLease | null>(() => currentLeaseFor(projectId));
  const [now, setNow] = useState(() => Date.now());
  const nameRef = useRef(editorName);
  nameRef.current = editorName;

  // 打开页面时：无人持锁则自动申请；他人持锁则保留其租约信息（本页据此显示只读与持锁者）。
  useEffect(() => {
    const existing = currentLeaseFor(projectId);
    if (!existing) {
      setLease(acquireLease(projectId, sessionId, nameRef.current));
    } else {
      // 无论持有者是否本人都保留；role/active 会按 holderId 是否匹配来计算。
      setLease(existing);
    }
  }, [projectId, sessionId]);

  // 每秒检查一次：续租 / 检测到期。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!lease || lease.holderId !== sessionId) return;
    if (new Date(lease.expiresAt).getTime() <= now) {
      setLease(null);
      return;
    }
    const age = now - new Date(lease.renewedAt).getTime();
    if (age >= LEASE_HEARTBEAT_MS) {
      const renewed = renewLease({ ...lease, holderName: nameRef.current });
      if (!renewed) setLease(null);
      else if (JSON.stringify(renewed) !== JSON.stringify(lease)) setLease(renewed);
    }
  }, [now, lease, sessionId]);

  // 其他页面的租约释放/变更事件（storage 事件不触发本页，这里只处理他页）。
  useEffect(() => {
    const onLeases = (leases: Record<string, EditLease>) => {
      const next = leases[projectId] && new Date(leases[projectId].expiresAt).getTime() > Date.now() ? leases[projectId] : null;
      setLease((current) => {
        if (current?.holderId === sessionId) {
          // 自己仍是持有者则继续以心跳为准；被别人抢走时让出。
          if (next && next.holderId !== sessionId) return null;
          return current;
        }
        return next;
      });
    };
    return busSubscribe(onLeases);
  }, [projectId, sessionId]);

  // 页面隐藏/关闭时释放租约，他页可立即接管；短暂切走（visibilitychange）保留，避免误抢。
  useEffect(() => {
    const onUnload = () => releaseLease(projectId, sessionId);
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      releaseLease(projectId, sessionId);
    };
  }, [projectId, sessionId]);

  const request = useCallback(() => acquireLease(projectId, sessionId, nameRef.current), [projectId, sessionId]);
  const release = useCallback(() => {
    releaseLease(projectId, sessionId);
    setLease(null);
  }, [projectId, sessionId]);
  const setHolderName = useCallback((name: string) => {
    const trimmed = name.trim() || `页面 ${sessionId.slice(-4).toUpperCase()}`;
    setEditorName(trimmed);
    setLease((current) => {
      if (current?.holderId !== sessionId) return current;
      const renewed = renewLease({ ...current, holderName: trimmed });
      return renewed ?? current;
    });
  }, [sessionId]);

  const active = lease && lease.projectId === projectId && lease.holderId === sessionId && new Date(lease.expiresAt).getTime() > now ? lease : null;
  const role: LeaseRole = active ? 'holder' : lease && lease.projectId === projectId ? 'other' : hadWritableLease ? 'stale' : 'none';
  const ttlSeconds = active ? Math.max(0, Math.ceil((new Date(active.expiresAt).getTime() - now) / 1000)) : 0;

  return { lease: active, role, ttlSeconds, request, release, setHolderName };
}

/** 单独的事件总线实例，避开模块顶层复杂初始化。 */
function busSubscribe(listener: (leases: Record<string, EditLease>) => void): () => void {
  window.addEventListener('storage', onStorage);
  function onStorage(event: StorageEvent) {
    if (event.key === LEASE_STORAGE_KEY) listener(readLeases());
  }
  return () => window.removeEventListener('storage', onStorage);
}
